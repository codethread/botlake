import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
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
import { dependencyAttributes, noteAttributes, noteRelations } from "./node-model.ts";
import { compileQuery, type Predicate } from "./query.ts";
import { sql } from "./sql.ts";

const stateSchema = z.compile(z.enum(["active", "closed", "replaced"]));

const rowSchema = z.compile(
  z.strictObject({
    id: z.string(),
    title: z.string(),
    state: stateSchema,
    created_at: z.string(),
    updated_at: z.string(),
    revision: z.number(),
  }),
);

const referenceSchema = z.compile(
  z.strictObject({
    lakeId: z.uuid(),
    workspace: z.string().min(1),
    nodeId: z.string().min(1),
    revision: z.number().int().positive(),
    observedAt: z.number(),
    status: z.enum(["current", "stale", "missing"]),
    kind: z.string().min(1).nullable(),
  }),
);
const nullableReferenceSchema = z.compile(referenceSchema.nullable());
const referenceSourceSchema = z.compile(
  referenceSchema.pick({ lakeId: true, workspace: true, nodeId: true }),
);
const referenceSnapshotSchema = z.compile(
  z.strictObject({
    title: z.string().trim().min(1),
    state: stateSchema,
    revision: z.number().int().positive(),
    kind: z.string().min(1).nullable().default(null),
  }),
);

export const nodeSchema = z.compile(
  rowSchema.extend({ attributes: attributesSchema, reference: nullableReferenceSchema }),
);

const edgeRow = z.compile(
  z.strictObject({
    from_id: z.string(),
    to_id: z.string(),
    relation: z.string(),
    attributes: z.string(),
  }),
);

const patchSchema = z.compile(
  z.strictObject({
    title: z.string().trim().min(1).optional(),
    state: stateSchema.exclude(["replaced"]).optional(),
    attributes: attributesSchema.optional(),
    expectedRevision: z.number().int().positive().optional(),
  }),
);

const edgeOpSchema = z.compile(
  z.discriminatedUnion("op", [
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
  ]),
);

export const batchSchema = z.compile(
  z.strictObject({
    refs: z.record(z.string().min(1), z.string().min(1)).default({}),
    nodes: z.array(patchSchema.extend({ ref: z.string().min(1) })).default([]),
    edges: z.array(edgeOpSchema).default([]),
    burn: z.array(z.string().min(1)).default([]),
  }),
);

const databaseVersionSchema = z.compile(z.object({ user_version: z.number() }));
const lakeIdentitySchema = z.compile(z.object({ lakeId: z.uuid() }));
const attributeRowsSchema = z.compile(z.array(z.object({ key: z.string(), value: z.string() })));
const limitSchema = z.compile(z.number().int().positive().max(10000));
const positiveIntegerSchema = z.compile(z.number().int().positive());
const offsetSchema = z.compile(z.number().int().nonnegative());
const countSchema = z.compile(z.object({ count: z.number().int().nonnegative() }));
const createSchema = z.compile(patchSchema.required({ title: true }));
const attributeKeysSchema = z.compile(z.array(z.string().min(1)).min(1));
const edgeRowsSchema = z.compile(z.array(edgeRow));
const nonemptyTextSchema = z.compile(z.string().min(1));
const referenceKindsSchema = z.compile(
  z
    .array(nonemptyTextSchema)
    .min(1)
    .refine((kinds) => new Set(kinds).size === kinds.length, "Reference kinds must be unique"),
);
const referenceKindsPath = `$.${JSON.stringify(dependencyAttributes.referenceKinds)}`;
const idRowSchema = z.compile(z.object({ id: z.string() }));
const idRowsSchema = z.compile(z.array(idRowSchema));
const keyRowsSchema = z.compile(z.array(z.object({ key: z.string() })));
const referenceRowsSchema = z.compile(z.array(rowSchema.extend({ reference: z.string() })));
const snapshotSchema = z.compile(
  rowSchema.pick({ id: true, title: true, state: true, revision: true }),
);
const snapshotRowsSchema = z.compile(z.array(snapshotSchema));
const summaryRowsSchema = z.compile(
  z.array(snapshotSchema.extend({ reference: z.string().nullable() })),
);
const snapshotIdsSchema = z.compile(z.array(nonemptyTextSchema).max(1000));
const referenceScopeSchema = z.compile(
  z
    .strictObject({
      lakeId: z.uuid().optional(),
      workspace: nonemptyTextSchema.optional(),
    })
    .refine(
      (scope) => scope.lakeId !== undefined || scope.workspace !== undefined,
      "Select a source lake identity or routing path",
    ),
);

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
  /** Source provenance for a read-only observed node; null for locally owned nodes. */
  reference: Reference | null;
}

export interface ReferenceSource {
  /** Persistent identity of the owning lake, independent of its published name or path. */
  lakeId: string;
  /** Canonical source workspace path used for peer routing. */
  workspace: string;
  /** Opaque node ID in the source lake. */
  nodeId: string;
}

export interface Reference extends ReferenceSource {
  /** Source revision of the retained summary. */
  revision: number;
  /** Time of the latest successful source observation, in milliseconds. */
  observedAt: number;
  /** Whether the retained summary is verified, disconnected or confirmed absent. */
  status: "current" | "stale" | "missing";
  /** Source-verified domain kind; null when the source supplies no domain evidence. */
  kind: string | null;
}

export interface NodeSnapshot {
  /** Opaque ID in the selected graph. */
  id: string;
  /** Current source title. */
  title: string;
  /** Source graph state, without domain-specific completion claims. */
  state: Node["state"];
  /** Source revision accompanying these facts. */
  revision: number;
}

export interface NodeSummary extends NodeSnapshot {
  /** Source ownership and observation facts; null for locally owned nodes. */
  reference: Reference | null;
}

export interface ReferenceSnapshot {
  /** Source title. */
  title: string;
  /** Observed source graph state. */
  state: Node["state"];
  /** Source revision accompanying these facts. */
  revision: number;
  /** Explicitly declared projection kind; omission records no domain evidence. */
  kind?: string | null;
}

export interface ReferenceSelection {
  /** Filter by the current routing path. */
  workspace?: string;
  /** Filter by persistent source identity. */
  lakeId?: string;
  /** Maximum returned nodes; defaults to 20, maximum 10,000. */
  limit?: number;
  /** Position in stable local-node ID order; defaults to zero. */
  offset?: number;
}

export interface ReferenceScope {
  /** Select a persistent source identity; at least one selector is required. */
  lakeId?: string;
  /** Select a routing path; supplying both selectors narrows their intersection. */
  workspace?: string;
}

export interface ReferencePage {
  /** Bounded reference nodes, without any source attributes. */
  nodes: Node[];
  /** Total matching references before pagination. */
  total: number;
  /** Continue at this offset; null means exhausted. */
  nextOffset: number | null;
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
  includeArchived?: boolean | undefined;
}

export class Graph {
  readonly db: Database;
  /** Persistent identity of this database, independent of workspace routing. */
  readonly lakeId: string;
  private readonly guards: Guard[] = [];
  private changes: Mutation[] = [];
  private commitActions: (() => void)[] = [];
  private writing = false;
  private currentAuthority: symbol | undefined;
  private readonly permissions = new WeakMap<Mutation, symbol>();
  private readonly referenceAuthority = Symbol("reference observations");

  constructor(
    path: string,
    private readonly nextId: () => string,
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
      const version = databaseVersionSchema.parse(
        this.db.query(sql`PRAGMA user_version`).get(),
      ).user_version;
      if (version === 0) {
        const tables = this.db
          .query(sql`
            SELECT name
            FROM sqlite_master
            WHERE type = 'table'
          `)
          .all();
        if (tables.length > 0) throw new Fault("schema", "Only fresh workspaces are supported");
        this.db
          .transaction(() => {
            this.db.run(ddl);
            for (const key of Object.values(noteAttributes)) this.declareImmutable(key);
          })
          .immediate();
      } else if (version !== 1)
        throw new Fault("schema", `Unsupported database generation: ${version}`);
      this.db.run(sql`
        CREATE INDEX IF NOT EXISTS burns_node_id ON burns(node_id);
        CREATE TABLE IF NOT EXISTS lake_metadata (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          lake_id TEXT NOT NULL UNIQUE
        );
        CREATE TABLE IF NOT EXISTS node_references (
          node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
          lakeId TEXT NOT NULL,
          workspace TEXT NOT NULL,
          nodeId TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK (revision > 0),
          observedAt INTEGER NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('current', 'stale', 'missing')),
          kind TEXT,
          UNIQUE (lakeId, nodeId)
        );
        CREATE INDEX IF NOT EXISTS references_workspace ON node_references(workspace, node_id);
        CREATE INDEX IF NOT EXISTS references_lake ON node_references(lakeId, node_id);
      `);
      this.db.query(sql`INSERT OR IGNORE INTO lake_metadata VALUES (1, ?)`).run(randomUUID());
      this.lakeId = lakeIdentitySchema.parse(
        this.db.query(sql`SELECT lake_id AS lakeId FROM lake_metadata WHERE singleton = 1`).get(),
      ).lakeId;
      this.db
        .transaction(() => {
          this.db
            .query(sql`
          UPDATE nodes SET revision = revision + 1, updated_at = ?
          WHERE id IN (SELECT node_id FROM node_references WHERE status = 'current')
        `)
            .run(new Date(this.now()).toISOString());
          this.db.run(sql`UPDATE node_references SET status = 'stale' WHERE status = 'current'`);
        })
        .immediate();
      this.protect((changes, authority) => {
        if (authority === this.referenceAuthority) return;
        for (const change of changes)
          if (change.kind === "node" && change.before !== null && change.before.reference !== null)
            throw new Fault(
              "reference-read-only",
              "Change source facts in the owning lake; use reference forget to remove this local reference",
              {
                id: change.before.id,
                lakeId: change.before.reference.lakeId,
                workspace: change.before.reference.workspace,
                nodeId: change.before.reference.nodeId,
              },
            );
      });
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

  get inTransaction(): boolean {
    return this.writing;
  }

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

  show(
    id: string,
    { includeArchived = true }: { includeArchived?: boolean | undefined } = {},
  ): Node {
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
    const attrs = attributeRowsSchema.parse(
      this.db
        .query(sql`
          SELECT key, value
          FROM attributes
          WHERE node_id = ? ${includeArchived ? "" : sql`AND archived = 0`}
          ORDER BY key
        `)
        .all(id),
    );
    return {
      ...row,
      attributes: Object.fromEntries(attrs.map((entry) => [entry.key, decode(entry.value)])),
      reference: nullableReferenceSchema.parse(
        this.db
          .query(sql`
            SELECT lakeId, workspace, nodeId, revision, observedAt, status, kind
            FROM node_references
            WHERE node_id = ?
          `)
          .get(id),
      ),
    };
  }

  /** Find the local read-only reference to one source node. */
  reference(lakeId: string, nodeId: string): Node | null {
    const row = this.db
      .query(sql`
        SELECT node_id AS id
        FROM node_references
        WHERE lakeId = ? AND nodeId = ?
      `)
      .get(lakeId, nodeId);
    return row === null ? null : this.show(idRowSchema.parse(row).id);
  }

  /** Filter and page references before reading their lightweight facts. Pages are not snapshots. */
  references(options: ReferenceSelection = {}): ReferencePage {
    const limit = limitSchema.parse(options.limit ?? 20);
    const offset = offsetSchema.parse(options.offset ?? 0);
    const workspace =
      options.workspace === undefined ? null : nonemptyTextSchema.parse(options.workspace);
    const lakeId = options.lakeId === undefined ? null : z.uuid().parse(options.lakeId);
    const where = sql`${workspace === null ? "1" : "r.workspace = ?"} AND ${lakeId === null ? "1" : "r.lakeId = ?"}`;
    const values = [
      ...(workspace === null ? [] : [workspace]),
      ...(lakeId === null ? [] : [lakeId]),
    ];
    const total = countSchema.parse(
      this.db
        .query(sql`
          SELECT COUNT(*) AS count FROM node_references r WHERE ${where}
    `)
        .get(...values),
    ).count;
    const rows = referenceRowsSchema.parse(
      this.db
        .query(sql`
      SELECT n.*, json_object(
        'lakeId', r.lakeId, 'workspace', r.workspace, 'nodeId', r.nodeId,
        'revision', r.revision, 'observedAt', r.observedAt, 'status', r.status, 'kind', r.kind
      ) AS reference
      FROM node_references r JOIN nodes n ON n.id = r.node_id
          WHERE ${where}
      ORDER BY r.node_id LIMIT ? OFFSET ?
    `)
        .all(...values, limit, offset),
    );
    return {
      nodes: rows.map(({ reference, ...row }) => ({
        ...row,
        attributes: {},
        reference: referenceSchema.parse(decode(reference)),
      })),
      total,
      nextOffset: offset + rows.length < total ? offset + rows.length : null,
    };
  }

  /** Read at most 1,000 source-owned core summaries without loading any attributes. */
  snapshots(ids: string[]): NodeSnapshot[] {
    const requested = snapshotIdsSchema.parse(ids);
    return snapshotRowsSchema.parse(
      this.db
        .query(sql`
      SELECT n.id, n.title, n.state, n.revision FROM nodes n
      WHERE n.id IN (SELECT value FROM json_each(?))
        AND NOT EXISTS (SELECT 1 FROM node_references r WHERE r.node_id = n.id)
      ORDER BY n.id
    `)
        .all(encode(requested)),
    );
  }

  /** Read at most 1,000 core summaries, including reference provenance, without attributes. */
  summaries(ids: string[]): NodeSummary[] {
    const requested = snapshotIdsSchema.parse(ids);
    const rows = summaryRowsSchema.parse(
      this.db
        .query(sql`
      SELECT n.id, n.title, n.state, n.revision, (
        SELECT json_object(
          'lakeId', r.lakeId, 'workspace', r.workspace, 'nodeId', r.nodeId,
          'revision', r.revision, 'observedAt', r.observedAt, 'status', r.status, 'kind', r.kind
        ) FROM node_references r WHERE r.node_id = n.id
      ) AS reference
      FROM nodes n WHERE n.id IN (SELECT value FROM json_each(?)) ORDER BY n.id
    `)
        .all(encode(requested)),
    );
    return rows.map(({ reference, ...row }) => ({
      ...row,
      reference: reference === null ? null : referenceSchema.parse(decode(reference)),
    }));
  }

  /** Retain only source identity and summary facts; source attributes remain remote. */
  observeReference(source: ReferenceSource, snapshot: ReferenceSnapshot | null): Node {
    const { lakeId, workspace, nodeId } = referenceSourceSchema.parse(source);
    if (lakeId === this.lakeId)
      throw new Fault("reference-local", "Use the locally owned node directly");
    const observed = snapshot === null ? null : referenceSnapshotSchema.parse(snapshot);
    return this.atomic(() => {
      const before = this.reference(lakeId, nodeId);
      if (observed === null && before === null)
        throw new Fault("reference-missing", "Cannot observe absence without a local reference");
      if (
        observed !== null &&
        before !== null &&
        before.reference !== null &&
        observed.revision < before.reference.revision
      )
        return before;
      const at = new Date(this.now()).toISOString();
      const id =
        before === null
          ? this.insertNode(
              requireValue(observed, "Missing reference snapshot").title,
              "active",
              at,
            )
          : before.id;
      this.db
        .query(sql`
          UPDATE nodes
          SET title = ?, state = ?, updated_at = ?, revision = revision + ?
          WHERE id = ?
        `)
        .run(
          observed?.title ?? requireValue(before, "Missing reference snapshot").title,
          observed?.state ?? requireValue(before, "Missing reference snapshot").state,
          at,
          before === null ? 0 : 1,
          id,
        );
      this.db
        .query(sql`
          INSERT INTO node_references (node_id, lakeId, workspace, nodeId, revision, observedAt, status, kind)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (node_id) DO UPDATE SET
            workspace = excluded.workspace,
            revision = excluded.revision,
            observedAt = excluded.observedAt,
            status = excluded.status,
            kind = excluded.kind
        `)
        .run(
          id,
          lakeId,
          workspace,
          nodeId,
          observed?.revision ??
            requireValue(before?.reference, "Missing reference metadata").revision,
          this.now(),
          observed === null ? "missing" : "current",
          observed === null
            ? requireValue(before?.reference, "Missing reference metadata").kind
            : observed.kind,
        );
      const after = this.show(id);
      this.record({ kind: "node", before, after });
      return after;
    }, this.referenceAuthority);
  }

  /** Disconnecting never erases retained facts or pretends that prerequisites completed. */
  invalidateReferences(source: ReferenceScope): number {
    const { lakeId, workspace } = referenceScopeSchema.parse(source);
    const where = sql`${lakeId === undefined ? "1" : "lakeId = ?"} AND ${workspace === undefined ? "1" : "workspace = ?"}`;
    const values = [
      ...(lakeId === undefined ? [] : [lakeId]),
      ...(workspace === undefined ? [] : [workspace]),
    ];
    return this.atomic(() => {
      const nodes = idRowsSchema.parse(
        this.db
          .query(sql`
            SELECT node_id AS id
            FROM node_references
            WHERE status = 'current'
              AND ${where}
          `)
          .all(...values),
      );
      for (const { id } of nodes) {
        const before = this.show(id);
        this.db
          .query(sql`
            UPDATE node_references SET status = 'stale' WHERE node_id = ?
          `)
          .run(id);
        this.db
          .query(sql`
            UPDATE nodes SET revision = revision + 1, updated_at = ? WHERE id = ?
          `)
          .run(new Date(this.now()).toISOString(), id);
        this.record({ kind: "node", before, after: this.show(id) });
      }
      return nodes.length;
    }, this.referenceAuthority);
  }

  list(
    options: Selection & { limit?: number | undefined; offset?: number | undefined } = {},
  ): Node[] {
    const limit = limitSchema.parse(options.limit ?? 100);
    const offset = offsetSchema.parse(options.offset ?? 0);
    return this.select(options, limit, offset);
  }

  all(options: Selection = {}): Node[] {
    return this.select(options);
  }

  count(options: Selection & { limit?: number | undefined } = {}): number {
    const limit =
      options.limit === undefined ? undefined : positiveIntegerSchema.parse(options.limit);
    const selection = this.compileSelection(options);
    const row = this.db
      .query(sql`
        SELECT COUNT(*) AS count
        FROM (
          SELECT 1
          FROM nodes s
          WHERE ${selection.sql}
          ${limit === undefined ? "" : sql`LIMIT ?`}
        )
      `)
      .get(...selection.bindings, ...(limit === undefined ? [] : [limit]));
    return countSchema.parse(row).count;
  }

  add(input: {
    title: string;
    state?: "active" | "closed" | undefined;
    attributes?: Attributes | undefined;
  }): Node {
    const parsed = createSchema.parse(input);

    return this.atomic(() => {
      const at = new Date(this.now()).toISOString();
      const id = this.insertNode(parsed.title, parsed.state ?? "active", at);
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

  /** Patch node fields; attribute objects merge recursively and null deletes keys. */
  update(id: string, input: Patch): Node {
    const patch = patchSchema.parse(input);
    return this.updateNode(
      id,
      patch,
      patch.attributes === undefined ? undefined : { mode: "merge", values: patch.attributes },
    );
  }

  /** Replace supplied attribute values verbatim, including null; retain unspecified keys. */
  setAttributes(id: string, values: Attributes, expectedRevision?: number): Node {
    const attributes = attributesSchema.parse(values);
    const revision =
      expectedRevision === undefined ? undefined : positiveIntegerSchema.parse(expectedRevision);
    return this.updateNode(
      id,
      { expectedRevision: revision },
      { mode: "replace", values: attributes },
    );
  }

  archive(id: string, keys: string[]): Node {
    attributeKeysSchema.parse(keys);

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
    return edgeRowsSchema
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
    nonemptyTextSchema.parse(relation);
    attributesSchema.parse(attributes);
    const referenceKinds = attributes[dependencyAttributes.referenceKinds];
    if (
      relation === "depends-on" &&
      referenceKinds !== undefined &&
      !referenceKindsSchema.safeParse(referenceKinds).success
    )
      throw new Fault(
        "dependency-reference-kinds",
        "Dependency reference kinds must be a nonempty array of unique nonempty strings",
        { attribute: dependencyAttributes.referenceKinds },
      );

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

  /** Whether an attribute key is a declared immutable fact. */
  isImmutable(key: string): boolean {
    return (
      this.db
        .query(sql`
          SELECT 1
          FROM immutable_keys
          WHERE key = ?
        `)
        .get(key) !== null
    );
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
      const next = this.show(replacement);
      if (before.reference !== null || next.reference !== null)
        throw new Fault("reference-read-only", "Supersession requires locally owned nodes");
      if (before.state === "replaced") throw new Fault("supersede", "Node is already replaced");
      if (id === replacement || next.state !== "active")
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

  /** Remove a local import deliberately; its source node is never changed. */
  forgetReference(id: string): void {
    this.atomic(() => {
      if (this.show(id).reference === null)
        throw new Fault("reference", "Expected a local reference node");
      this.burn([id]);
    }, this.referenceAuthority);
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
  subgraph(
    root: string,
    relation = "parent-of",
    options: { includeArchived?: boolean | undefined } = {},
  ): { nodes: Node[]; edges: Edge[] } {
    this.show(root);
    const ids = idRowsSchema
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
      nodes: ids.map((id) => this.show(id, options)),
      edges: this.edges().filter((edge) => members.has(edge.from_id) && members.has(edge.to_id)),
    };
  }

  note(target: string, text: string, attributes: Attributes = {}): Node {
    nonemptyTextSchema.parse(text);

    return this.atomic(() => {
      this.show(target);
      const note = this.add({
        title: "Note",
        state: "closed",
        attributes: {
          ...attributes,
          [noteAttributes.text]: text,
          [noteAttributes.at]: new Date(this.now()).toISOString(),
        },
      });
      this.connect(note.id, target, noteRelations.notes);

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

  private insertNode(title: string, state: "active" | "closed", at: string): string {
    for (let attempt = 0; attempt < 32; attempt++) {
      const id = this.nextId();
      const result = this.db
        .query(sql`
          INSERT INTO nodes (id, title, state, created_at, updated_at, revision)
          SELECT ?, ?, ?, ?, ?, 1
          WHERE NOT EXISTS (
            SELECT 1
            FROM burns
            WHERE node_id = ?
          )
          ON CONFLICT (id) DO NOTHING
        `)
        .run(id, title, state, at, at, id);
      if (result.changes === 1) return id;
    }
    throw new Fault("id-exhausted", "Unable to allocate a node ID after 32 attempts");
  }

  private record(change: Mutation): void {
    if (this.currentAuthority !== undefined) this.permissions.set(change, this.currentAuthority);
    this.changes.push(change);
  }

  private select(options: Selection, limit?: number, offset = 0): Node[] {
    const selection = this.compileSelection(options);
    const ids = idRowsSchema.parse(
      this.db
        .query(sql`
          SELECT s.id
          FROM nodes s
          WHERE ${selection.sql}
          ORDER BY s.created_at, s.id
          ${limit === undefined ? "" : sql`LIMIT ? OFFSET ?`}
        `)
        .all(...selection.bindings, ...(limit === undefined ? [] : [limit, offset])),
    );
    return ids.map(({ id }) =>
      this.show(id, { includeArchived: options.includeArchived ?? false }),
    );
  }

  private compileSelection(options: Selection): ReturnType<typeof compileQuery> {
    const query =
      options.where === undefined
        ? { sql: sql`1`, bindings: [] }
        : compileQuery(options.where, options.params);
    const ready =
      options.ready === true
        ? sql`
          AND s.state = 'active'
          AND NOT EXISTS (
            SELECT 1 FROM node_references own WHERE own.node_id = s.id
          )
          AND NOT EXISTS (
            SELECT 1
            FROM edges e
            JOIN nodes target ON target.id = e.to_id
            LEFT JOIN node_references observed ON observed.node_id = target.id
            WHERE e.from_id = s.id
              AND e.relation = 'depends-on'
              AND (
                target.state = 'active'
                OR (
                  observed.node_id IS NOT NULL
                  AND (
                    observed.status <> 'current' OR target.state <> 'closed'
                    OR (
                      json_type(e.attributes, ?) IS NOT NULL
                      AND NOT EXISTS (
                        SELECT 1 FROM json_each(e.attributes, ?) accepted
                        WHERE accepted.value = observed.kind
                      )
                    )
                  )
                )
              )
          )
        `
        : "";
    return {
      sql: sql`${query.sql} ${ready}`,
      bindings:
        options.ready === true
          ? [...query.bindings, referenceKindsPath, referenceKindsPath]
          : query.bindings,
    };
  }

  private updateNode(
    id: string,
    patch: Pick<Patch, "title" | "state" | "expectedRevision">,
    attributes?: { mode: "merge" | "replace"; values: Attributes },
  ): Node {
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
      if (attributes !== undefined) this.writeAttributes(id, attributes.values, attributes.mode);

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

  private writeAttributes(id: string, values: Attributes, mode: "merge" | "replace"): void {
    const before = this.show(id).attributes;
    const after = mode === "merge" ? merge(before, values) : { ...before, ...values };

    const keys = keyRowsSchema.parse(
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

    for (const key of Object.keys(values)) {
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
