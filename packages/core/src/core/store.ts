import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { z } from "zod";

import {
  attributesSchema,
  canonical,
  decode,
  encode,
  Fault,
  merge,
  object,
  requireValue,
  type Attributes,
} from "./json.ts";
import { compileQuery, type Predicate } from "./query.ts";
import { sql } from "./sql.ts";

const stateSchema = z.enum(["active", "closed", "replaced"]);

const rowSchema = z.strictObject({
  id: z.string(),
  title: z.string(),
  state: stateSchema,
  created_at: z.string(),
  updated_at: z.string(),
  revision: z.number(),
});

export const nodeSchema = rowSchema.extend({ attributes: attributesSchema });

const edgeRow = z.strictObject({
  from_id: z.string(),
  to_id: z.string(),
  relation: z.string(),
  attributes: z.string(),
});

const patchSchema = z.strictObject({
  title: z.string().trim().min(1).optional(),
  state: z.enum(["active", "closed"]).optional(),
  attributes: attributesSchema.optional(),
  expectedRevision: z.number().int().positive().optional(),
});

const edgeOpSchema = z.discriminatedUnion("op", [
  z.strictObject({
    op: z.literal("upsert"),
    from: z.string().min(1),
    to: z.string().min(1),
    relation: z.string().min(1),
    attributes: attributesSchema.default({}),
  }),
  z.strictObject({
    op: z.literal("remove"),
    from: z.string().min(1),
    to: z.string().min(1),
    relation: z.string().min(1),
  }),
]);

export const batchSchema = z.strictObject({
  refs: z.record(z.string().min(1), z.string().min(1)).default({}),
  nodes: z.array(patchSchema.extend({ ref: z.string().min(1) })).default([]),
  edges: z.array(edgeOpSchema).default([]),
  burn: z.array(z.string().min(1)).default([]),
});

const ddl = sql`
  CREATE TABLE nodes (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('active', 'closed', 'replaced')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    revision INTEGER NOT NULL
  );

  CREATE TABLE attributes (
    node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    value TEXT NOT NULL CHECK (json_valid(value)),
    archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
    PRIMARY KEY (node_id, key)
  );
  CREATE INDEX attrs_hot ON attributes(key, value) WHERE archived = 0;

  CREATE TABLE edges (
    from_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    to_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    relation TEXT NOT NULL,
    attributes TEXT NOT NULL CHECK (json_valid(attributes)),
    PRIMARY KEY (from_id, to_id, relation),
    CHECK (from_id <> to_id)
  );
  CREATE INDEX edges_to ON edges(to_id, relation);
  CREATE UNIQUE INDEX single_serves ON edges(from_id) WHERE relation = 'serves';

  CREATE TABLE acyclic_relations (relation TEXT PRIMARY KEY);
  INSERT INTO acyclic_relations
  VALUES ('depends-on'), ('parent-of'), ('supersedes'), ('serves'), ('notes');

  CREATE TABLE immutable_keys (key TEXT PRIMARY KEY);
  INSERT INTO immutable_keys VALUES ('note/text'), ('note/at');

  CREATE TABLE burns (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id TEXT NOT NULL,
    snapshot TEXT NOT NULL,
    at INTEGER NOT NULL
  );

  CREATE TABLE wakes (
    key TEXT PRIMARY KEY,
    at INTEGER NOT NULL,
    handler TEXT NOT NULL,
    payload TEXT NOT NULL,
    generation TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE wake_history (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL,
    generation TEXT NOT NULL,
    status TEXT NOT NULL,
    at INTEGER NOT NULL,
    error TEXT
  );

  PRAGMA user_version = 1;
`;

export interface Node {
  id: string;
  title: string;
  state: z.infer<typeof stateSchema>;
  created_at: string;
  updated_at: string;
  revision: number;
  attributes: Attributes;
}

export interface Edge {
  from_id: string;
  to_id: string;
  relation: string;
  attributes: Attributes;
}

export type Patch = z.infer<typeof patchSchema>;

export interface Change {
  kind: "node";
  before: Node | null;
  after: Node | null;
  expectedRevision?: number | undefined;
}

export interface EdgeChange {
  kind: "edge";
  before: Edge | null;
  after: Edge | null;
}

export type Mutation = Change | EdgeChange;

export interface GraphEvent {
  type: "graph/committed";
  changes: Mutation[];
  at: number;
}

export type Guard = (changes: readonly Mutation[], authority: symbol | undefined) => void;

export interface Selection {
  where?: Predicate | undefined;
  params?: Attributes | undefined;
  ready?: boolean | undefined;
  lean?: boolean | undefined;
}

export class Graph {
  readonly db: Database;
  private readonly guards: Guard[] = [];
  private changes: Mutation[] = [];
  private commitActions: (() => void)[] = [];
  private writing = false;
  private currentAuthority: symbol | undefined;
  private readonly permissions = new WeakMap<Mutation, symbol>();

  constructor(
    path: string,
    private readonly now: () => number = Date.now,
    private readonly publish: (event: GraphEvent) => void = () => {},
  ) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true, strict: true });
    try {
      this.db.run(sql`
        PRAGMA journal_mode = WAL;
        PRAGMA foreign_keys = ON;
        PRAGMA busy_timeout = 5000;
      `);
      const version = z
        .object({ user_version: z.number() })
        .parse(this.db.query(sql`PRAGMA user_version`).get()).user_version;
      if (version === 0) {
        const tables = this.db
          .query(sql`
            SELECT name
            FROM sqlite_master
            WHERE type = 'table'
          `)
          .all();
        if (tables.length > 0) throw new Fault("schema", "Only fresh workspaces are supported");
        this.db.transaction(() => this.db.run(ddl)).immediate();
      } else if (version !== 1)
        throw new Fault("schema", `Unsupported database generation: ${version}`);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  protect(guard: Guard): void {
    this.guards.push(guard);
  }

  // Timer/resource side effects wait for the enclosing synchronous transaction.

  afterCommit(action: () => void): void {
    if (this.writing) this.commitActions.push(action);
    else action();
  }

  atomic<T>(work: () => T, authority?: symbol): T {
    const outer = !this.writing;
    const start = this.changes.length;
    const actionStart = this.commitActions.length;
    const previousAuthority = this.currentAuthority;
    this.writing = true;
    if (outer || authority !== undefined) this.currentAuthority = authority;
    let result: T;
    try {
      result = this.db
        .transaction(() => {
          const value = work();
          if (value instanceof Promise)
            throw new Fault("transaction", "Graph transactions must be synchronous");
          if (outer)
            for (const change of this.changes)
              for (const guard of this.guards) guard([change], this.permissions.get(change));
          return value;
        })
        .immediate();
    } catch (error) {
      // Bun uses savepoints for nested transactions. Match their rollback in the
      // pending events and side effects when a caller catches an inner failure.
      this.changes.length = start;
      this.commitActions.length = actionStart;
      throw error;
    } finally {
      this.writing = !outer;
      this.currentAuthority = previousAuthority;
    }
    if (outer) {
      const changes = this.changes;
      const actions = this.commitActions;
      this.changes = [];
      this.commitActions = [];
      if (changes.length > 0) this.publish({ type: "graph/committed", changes, at: this.now() });
      for (const action of actions) action();
    }
    return result;
  }

  show(id: string, lean = false): Node {
    const row = rowSchema.parse(
      requireValue(
        this.db
          .query(sql`
            SELECT *
            FROM nodes
            WHERE id = ?
          `)
          .get(id),
        `Unknown node: ${id}`,
      ),
    );
    const attrs = z.array(z.object({ key: z.string(), value: z.string() })).parse(
      this.db
        .query(sql`
          SELECT key, value
          FROM attributes
          WHERE node_id = ? ${lean ? sql`AND archived = 0` : ""}
          ORDER BY key
        `)
        .all(id),
    );
    return {
      ...row,
      attributes: Object.fromEntries(attrs.map((entry) => [entry.key, decode(entry.value)])),
    };
  }

  list(options: Selection & { limit?: number | undefined } = {}): Node[] {
    const limit = z
      .number()
      .int()
      .positive()
      .max(10000)
      .parse(options.limit ?? 100);
    return this.select(options, limit);
  }

  all(options: Selection = {}): Node[] {
    return this.select(options);
  }

  add(input: {
    title: string;
    state?: "active" | "closed" | undefined;
    attributes?: Attributes | undefined;
  }): Node {
    const parsed = patchSchema.required({ title: true }).parse(input);

    return this.atomic(() => {
      const id = crypto.randomUUID();
      const at = new Date(this.now()).toISOString();
      this.db
        .query(sql`
          INSERT INTO nodes
          VALUES (?, ?, ?, ?, ?, 1)
        `)
        .run(id, parsed.title, parsed.state ?? "active", at, at);
      for (const [key, value] of Object.entries(parsed.attributes ?? {}))
        this.db
          .query(sql`
            INSERT INTO attributes
            VALUES (?, ?, ?, 0)
          `)
          .run(id, key, encode(value));

      const after = this.show(id);
      this.record({ kind: "node", before: null, after });
      return after;
    });
  }

  update(id: string, input: Patch): Node {
    const patch = patchSchema.parse(input);

    return this.atomic(() => {
      const before = this.show(id);
      if (patch.expectedRevision !== undefined && before.revision !== patch.expectedRevision)
        throw new Fault("stale", `Stale revision for ${id}`, {
          expected: patch.expectedRevision,
          actual: before.revision,
        });

      this.db
        .query(sql`
          UPDATE nodes
          SET title = ?,
              state = ?,
              updated_at = ?,
              revision = revision + 1
          WHERE id = ?
        `)
        .run(
          patch.title ?? before.title,
          patch.state ?? before.state,
          new Date(this.now()).toISOString(),
          id,
        );
      if (patch.attributes !== undefined) this.writeAttributes(id, patch.attributes);

      const after = this.show(id);
      this.record({
        kind: "node",
        before,
        after,
        ...(patch.expectedRevision === undefined
          ? {}
          : { expectedRevision: patch.expectedRevision }),
      });
      return after;
    });
  }

  archive(id: string, keys: string[]): Node {
    z.array(z.string().min(1)).min(1).parse(keys);

    return this.atomic(() => {
      const before = this.show(id);
      for (const key of keys) {
        if (before.attributes[key] === undefined)
          throw new Fault("archive", `Unknown attribute: ${key}`);
        if (
          this.db
            .query(sql`
              SELECT 1
              FROM immutable_keys
              WHERE key = ?
            `)
            .get(key) !== null
        )
          throw new Fault("immutable", `Immutable attribute: ${key}`);
        this.db
          .query(sql`
            UPDATE attributes
            SET archived = 1
            WHERE node_id = ?
              AND key = ?
          `)
          .run(id, key);
      }

      this.db
        .query(sql`
          UPDATE nodes
          SET revision = revision + 1,
              updated_at = ?
          WHERE id = ?
        `)
        .run(new Date(this.now()).toISOString(), id);
      const after = this.show(id);
      this.record({ kind: "node", before, after });
      return after;
    });
  }

  edges(id?: string, relation?: string): Edge[] {
    return z
      .array(edgeRow)
      .parse(
        this.db
          .query(sql`
            SELECT *
            FROM edges
            WHERE (? IS NULL OR from_id = ? OR to_id = ?)
              AND (? IS NULL OR relation = ?)
            ORDER BY from_id, to_id, relation
          `)
          .all(id ?? null, id ?? null, id ?? null, relation ?? null, relation ?? null),
      )
      .map((edge) => ({ ...edge, attributes: object(edge.attributes) }));
  }

  edge(from: string, to: string, relation: string): Edge | null {
    const row = this.db
      .query(sql`
        SELECT *
        FROM edges
        WHERE from_id = ?
          AND to_id = ?
          AND relation = ?
      `)
      .get(from, to, relation);
    if (row === null) return null;
    const parsed = edgeRow.parse(row);
    return { ...parsed, attributes: object(parsed.attributes) };
  }

  connect(from: string, to: string, relation: string, attributes: Attributes = {}): Edge {
    z.string().min(1).parse(relation);
    attributesSchema.parse(attributes);

    return this.atomic(() => {
      const before = this.edge(from, to, relation);

      if (
        this.db
          .query(sql`
            SELECT 1
            FROM acyclic_relations
            WHERE relation = ?
          `)
          .get(relation) !== null
      ) {
        const cycle = this.db
          .query(sql`
            WITH RECURSIVE reachable(id) AS (
              SELECT ?
              UNION
              SELECT e.to_id
              FROM edges e
              JOIN reachable r ON e.from_id = r.id
              WHERE e.relation = ?
            )
            SELECT 1
            FROM reachable
            WHERE id = ?
          `)
          .get(to, relation, from);
        if (cycle !== null) throw new Fault("cycle", `Cycle in ${relation}`);
      }

      this.db
        .query(sql`
          INSERT INTO edges
          VALUES (?, ?, ?, ?)
          ON CONFLICT (from_id, to_id, relation) DO UPDATE SET
            attributes = excluded.attributes
        `)
        .run(from, to, relation, encode(attributes));
      const after = { from_id: from, to_id: to, relation, attributes };
      this.record({ kind: "edge", before, after });
      return after;
    });
  }

  disconnect(from: string, to: string, relation: string): Edge {
    return this.atomic(() => {
      const before = requireValue(this.edge(from, to, relation), "Unknown edge");
      this.db
        .query(sql`
          DELETE FROM edges
          WHERE from_id = ?
            AND to_id = ?
            AND relation = ?
        `)
        .run(from, to, relation);
      this.record({ kind: "edge", before, after: null });
      return before;
    });
  }

  declareAcyclic(relation: string): void {
    this.atomic(() => {
      if (
        this.db
          .query(sql`
            SELECT 1
            FROM acyclic_relations
            WHERE relation = ?
          `)
          .get(relation) !== null
      )
        return;
      if (
        this.db
          .query(sql`
            SELECT 1
            FROM edges
            WHERE relation = ?
            LIMIT 1
          `)
          .get(relation) !== null
      )
        throw new Fault("relation", "Declare acyclic relations before adding edges");
      this.db
        .query(sql`
          INSERT INTO acyclic_relations
          VALUES (?)
        `)
        .run(relation);
    });
  }

  declareImmutable(key: string): void {
    this.db
      .query(sql`
        INSERT OR IGNORE INTO immutable_keys
        VALUES (?)
      `)
      .run(key);
  }

  supersede(id: string, replacement: string): Node {
    return this.atomic(() => {
      const before = this.show(id);
      if (before.state === "replaced") throw new Fault("supersede", "Node is already replaced");
      if (id === replacement || this.show(replacement).state !== "active")
        throw new Fault("supersede", "Replacement must be a different active node");

      this.db
        .query(sql`
          UPDATE nodes
          SET state = 'replaced',
              revision = revision + 1,
              updated_at = ?
          WHERE id = ?
        `)
        .run(new Date(this.now()).toISOString(), id);
      this.record({ kind: "node", before, after: this.show(id) });
      this.connect(replacement, id, "supersedes");
      for (const edge of this.edges(id, "depends-on").filter((entry) => entry.to_id === id)) {
        if (this.edge(edge.from_id, replacement, "depends-on") === null)
          this.connect(edge.from_id, replacement, "depends-on", edge.attributes);
        this.disconnect(edge.from_id, id, "depends-on");
      }

      return this.show(replacement);
    });
  }

  burn(ids: string[]): Node[] {
    if (new Set(ids).size !== ids.length) throw new Fault("burn", "Duplicate node to burn");

    return this.atomic(() => {
      const records = ids.map((id) => {
        const node = this.show(id);
        const attributes = this.db
          .query(sql`
            SELECT key, value, archived
            FROM attributes
            WHERE node_id = ?
          `)
          .all(id);
        return { node, attributes, edges: this.edges(id) };
      });

      const removedEdges = new Map<string, Edge>();
      for (const record of records) {
        this.db
          .query(sql`
            INSERT INTO burns (node_id, snapshot, at)
            VALUES (?, ?, ?)
          `)
          .run(record.node.id, encode(record), this.now());
        this.record({ kind: "node", before: record.node, after: null });
        for (const edge of record.edges)
          removedEdges.set(encode([edge.from_id, edge.to_id, edge.relation]), edge);
      }
      for (const edge of removedEdges.values())
        this.record({ kind: "edge", before: edge, after: null });

      for (const id of ids)
        this.db
          .query(sql`
            DELETE FROM nodes
            WHERE id = ?
          `)
          .run(id);
      return records.map(({ node }) => node);
    });
  }

  tombstones(id: string): unknown[] {
    return this.db
      .query(sql`
        SELECT *
        FROM burns
        WHERE node_id = ?
        ORDER BY sequence
      `)
      .all(id);
  }
  subgraph(root: string, relation = "parent-of"): { nodes: Node[]; edges: Edge[] } {
    this.show(root);
    const ids = z
      .array(z.object({ id: z.string() }))
      .parse(
        this.db
          .query(sql`
            WITH RECURSIVE tree(id) AS (
              SELECT ?
              UNION
              SELECT e.to_id
              FROM edges e
              JOIN tree t ON e.from_id = t.id
              WHERE e.relation = ?
            )
            SELECT id
            FROM tree
          `)
          .all(root, relation),
      )
      .map(({ id }) => id);
    const members = new Set(ids);
    return {
      nodes: ids.map((id) => this.show(id)),
      edges: this.edges().filter((edge) => members.has(edge.from_id) && members.has(edge.to_id)),
    };
  }

  note(target: string, text: string, attributes: Attributes = {}): Node {
    z.string().min(1).parse(text);

    return this.atomic(() => {
      this.show(target);
      const note = this.add({
        title: "Note",
        state: "closed",
        attributes: {
          ...attributes,
          "note/text": text,
          "note/at": new Date(this.now()).toISOString(),
        },
      });
      this.connect(note.id, target, "notes");

      return note;
    });
  }
  batch(input: unknown): { refs: Record<string, string>; changes: Mutation[] } {
    const payload = batchSchema.parse(input);
    const bound = Object.values(payload.refs);
    if (new Set(bound).size !== bound.length) throw new Fault("batch", "Duplicate node in refs");
    if (new Set(payload.burn).size !== payload.burn.length)
      throw new Fault("batch", "Duplicate burn ref");

    return this.atomic(() => {
      const start = this.changes.length;
      const refs = { ...payload.refs };
      const touched = new Set<string>();

      for (const id of Object.values(refs)) this.show(id);
      for (const { ref, ...patch } of payload.nodes) {
        if (touched.has(ref) || payload.burn.includes(ref))
          throw new Fault("batch", `Duplicate mutation: ${ref}`);
        touched.add(ref);
        const id = refs[ref];
        if (id === undefined) {
          if (patch.expectedRevision !== undefined)
            throw new Fault("batch", "A new node has no revision to compare");
          refs[ref] = this.add({
            ...patch,
            title: requireValue(patch.title, `New ref ${ref} needs title`),
          }).id;
        } else this.update(id, patch);
      }

      for (const edge of payload.edges) {
        const from = requireValue(refs[edge.from], `Unknown ref: ${edge.from}`);
        const to = requireValue(refs[edge.to], `Unknown ref: ${edge.to}`);
        if (edge.op === "upsert") this.connect(from, to, edge.relation, edge.attributes);
        else {
          if (payload.refs[edge.from] === undefined || payload.refs[edge.to] === undefined)
            throw new Fault("batch", "Remove requires pre-bound refs");
          this.disconnect(from, to, edge.relation);
        }
      }

      this.burn(payload.burn.map((ref) => requireValue(refs[ref], `Unknown burn ref: ${ref}`)));
      return { refs, changes: this.changes.slice(start) };
    });
  }

  // -- Private helpers --

  private record(change: Mutation): void {
    if (this.currentAuthority !== undefined) this.permissions.set(change, this.currentAuthority);
    this.changes.push(change);
  }

  private select(options: Selection, limit?: number): Node[] {
    const query =
      options.where === undefined
        ? { sql: sql`1`, bindings: [] }
        : compileQuery(options.where, options.params);
    const ready =
      options.ready === true
        ? sql`
          AND s.state = 'active'
          AND NOT EXISTS (
            SELECT 1
            FROM edges e
            JOIN nodes target ON target.id = e.to_id
            WHERE e.from_id = s.id
              AND e.relation = 'depends-on'
              AND target.state = 'active'
          )
        `
        : "";
    const ids = z.array(z.object({ id: z.string() })).parse(
      this.db
        .query(sql`
          SELECT s.id
          FROM nodes s
          WHERE ${query.sql} ${ready}
          ORDER BY s.created_at, s.id
          ${limit === undefined ? "" : sql`LIMIT ?`}
        `)
        .all(...query.bindings, ...(limit === undefined ? [] : [limit])),
    );
    return ids.map(({ id }) => this.show(id, options.lean ?? true));
  }

  private writeAttributes(id: string, patch: Attributes): void {
    const before = this.show(id).attributes;
    const after = merge(before, patch);

    const keys = z.array(z.object({ key: z.string() })).parse(
      this.db
        .query(sql`
          SELECT key
          FROM immutable_keys
        `)
        .all(),
    );
    for (const { key } of keys)
      if (
        before[key] !== undefined &&
        (after[key] === undefined || canonical(before[key]) !== canonical(after[key]))
      )
        throw new Fault("immutable", `Immutable attribute: ${key}`);

    for (const key of Object.keys(patch)) {
      const value = after[key];
      if (value === undefined)
        this.db
          .query(sql`
            DELETE FROM attributes
            WHERE node_id = ?
              AND key = ?
          `)
          .run(id, key);
      else
        this.db
          .query(sql`
            INSERT INTO attributes
            VALUES (?, ?, ?, 0)
            ON CONFLICT (node_id, key) DO UPDATE SET
              value = excluded.value,
              archived = 0
          `)
          .run(id, key, encode(value));
    }
  }
}
