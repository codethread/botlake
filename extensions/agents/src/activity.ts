import { Fault, q, sql, type Context, type Node } from "@botlake/core";
import { providerSchema, type NativeRegistration } from "@botlake/native-session";
import { z } from "zod";

import {
  agentAttributes,
  runActivityAttributes,
  runActivityRelations,
  runActivityStreamSchema,
  runActivityEventSchema,
} from "./node-model.ts";

const headers = z.compile(z.array(runActivityStreamSchema));
const events = z.compile(z.array(runActivityEventSchema));
const wakeSchema = z.compile(z.object({ id: z.string() }));
const boundaries = {
  "session-start": "session-started",
  "session-end": "session-ended",
  "agent-start": "turn-started",
  "agent-end": "turn-ended",
  metadata: null,
} as const;
const headerColumns = sql`
  id, run_id AS run, invocation, identity, provider, session_id AS sessionId,
  session_path AS sessionPath, capabilities, started_at AS startedAt,
  last_observed_at AS lastObservedAt, ended_at AS endedAt,
  expires_at AS expiresAt, expired_at AS expiredAt, event_count AS eventCount
`;
const eventColumns = sql`
  sequence, activity_id AS activity, at, kind, turn_id AS turnId,
  call_id AS callId, tool, role, summary, outcome, truncated, usage
`;

const text = z.string().min(1);
const limit = z.number().int().min(1).max(100).default(20);
const pagination = { after: z.number().int().nonnegative().default(0), limit };

/** Distinct reads keep paging, phrase search and targeted inspection independent. */
export const activityReadSchema = z.compile(
  z.discriminatedUnion("operation", [
    z.strictObject({ operation: z.literal("list"), id: text.optional(), ...pagination }),
    z.strictObject({
      operation: z.literal("search"),
      id: text.optional(),
      query: text,
      ...pagination,
    }),
    z.strictObject({ operation: z.literal("peek"), id: text, limit }),
  ]),
);

export type ActivityRead = z.infer<typeof activityReadSchema>;

/** SQL owns log volume; one graph handle survives each stream's eventual expiry. */
export class RunActivity {
  constructor(
    private readonly ctx: Context,
    private readonly authority: symbol,
    private readonly retentionMs: number,
  ) {
    ctx.graph.db.run(sql`
      CREATE TABLE IF NOT EXISTS run_activity (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, invocation TEXT, identity TEXT,
        provider TEXT NOT NULL, session_id TEXT, session_path TEXT,
        capabilities TEXT NOT NULL DEFAULT '[]', started_at INTEGER NOT NULL,
        last_observed_at INTEGER, ended_at INTEGER, expires_at INTEGER,
        expired_at INTEGER, event_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS run_activity_runs ON run_activity(run_id);
      CREATE INDEX IF NOT EXISTS run_activity_identities ON run_activity(identity);
      CREATE INDEX IF NOT EXISTS run_activity_expiry ON run_activity(expires_at)
        WHERE expired_at IS NULL;
      CREATE TABLE IF NOT EXISTS run_activity_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        activity_id TEXT NOT NULL REFERENCES run_activity(id), at INTEGER NOT NULL,
        kind TEXT NOT NULL, turn_id TEXT, call_id TEXT, tool TEXT, role TEXT,
        summary TEXT NOT NULL, outcome TEXT, truncated INTEGER NOT NULL, usage TEXT
      );
      CREATE INDEX IF NOT EXISTS run_activity_page ON run_activity_events(activity_id, sequence);
      CREATE INDEX IF NOT EXISTS run_activity_calls ON run_activity_events(activity_id, call_id, kind);
      CREATE VIRTUAL TABLE IF NOT EXISTS run_activity_search USING fts5(
        summary, content='run_activity_events', content_rowid='sequence'
      );
      CREATE TRIGGER IF NOT EXISTS run_activity_search_insert AFTER INSERT ON run_activity_events BEGIN
        INSERT INTO run_activity_search(rowid, summary) VALUES (new.sequence, new.summary);
      END;
      CREATE TRIGGER IF NOT EXISTS run_activity_search_delete AFTER DELETE ON run_activity_events BEGIN
        INSERT INTO run_activity_search(run_activity_search, rowid, summary)
          VALUES ('delete', old.sequence, old.summary);
      END;
    `);
    ctx.scheduler.register("agents/activity-expire", (wake) => {
      const { id } = wakeSchema.parse(wake.payload);
      this.expire(id);
    });
    ctx.graph.protect((changes, token) => {
      if (token === authority) return;
      for (const change of changes) {
        if (
          change.kind === "node" &&
          (change.before?.attributes[runActivityAttributes.stream] === true ||
            change.after?.attributes[runActivityAttributes.stream] === true)
        )
          throw new Fault("activity", "Run activity handles require Agents");
        if (
          change.kind === "edge" &&
          Object.values(runActivityRelations).some(
            (relation) => relation === (change.after ?? change.before)?.relation,
          )
        )
          throw new Fault("activity", "Run activity links require Agents");
      }
    });
  }

  create(run: Node, invocation: string | null): string {
    return this.ctx.graph.atomic(() => {
      const handle = this.ctx.graph.add({
        title: `Run activity ${run.id}`,
        state: "closed",
        attributes: { [runActivityAttributes.stream]: true },
      });
      this.ctx.graph.db
        .query(sql`
        INSERT INTO run_activity(id, run_id, invocation, provider, started_at)
        VALUES (?, ?, ?, ?, ?)
      `)
        .run(
          handle.id,
          run.id,
          invocation,
          providerSchema.parse(run.attributes[agentAttributes.provider]),
          this.ctx.clock.now(),
        );
      this.ctx.graph.connect(handle.id, run.id, runActivityRelations.run);
      this.ctx.graph.update(run.id, { attributes: { [agentAttributes.activity]: handle.id } });
      return handle.id;
    }, this.authority);
  }

  observe(
    run: Node,
    input: NativeRegistration,
    identity: { identity: string; nodeId: string },
  ): void {
    this.ctx.graph.atomic(() => {
      const reference = run.attributes[agentAttributes.activity];
      let stream = typeof reference === "string" ? this.header(reference) : null;
      if (
        stream === null ||
        (input.event === "session-start" &&
          stream.endedAt !== null &&
          run.attributes[agentAttributes.external] === true)
      )
        stream = this.header(this.create(run, input.invocation ?? null));
      if (stream.expiredAt !== null) return;
      this.ctx.graph.db
        .query(sql`
        UPDATE run_activity SET identity = ?, session_id = ?,
          session_path = COALESCE(?, session_path), capabilities = COALESCE(?, capabilities)
        WHERE id = ?
      `)
        .run(
          identity.identity,
          input.nativeSessionId,
          input.sessionPath ?? null,
          input.capabilities === undefined ? null : JSON.stringify(input.capabilities),
          stream.id,
        );
      if (this.ctx.graph.edge(stream.id, identity.nodeId, runActivityRelations.identity) === null)
        this.ctx.graph.connect(stream.id, identity.nodeId, runActivityRelations.identity);

      const kind = boundaries[input.event];
      const boundary =
        kind === null
          ? []
          : [{ kind, turnId: input.turnId ?? null, summary: "", truncated: false }];
      const details = input.activity ?? [];
      const rows =
        input.event === "agent-end" || input.event === "session-end"
          ? [...details, ...boundary]
          : [...boundary, ...details];
      for (const entry of rows) {
        this.ctx.graph.db
          .query(sql`
          INSERT INTO run_activity_events(activity_id, at, kind, turn_id, call_id, tool, role, summary, outcome, truncated, usage)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
          .run(
            stream.id,
            this.ctx.clock.now(),
            entry.kind,
            entry.turnId,
            "callId" in entry ? entry.callId : null,
            "tool" in entry ? entry.tool : null,
            "role" in entry ? entry.role : null,
            "summary" in entry ? entry.summary : "",
            "outcome" in entry ? entry.outcome : null,
            Number("truncated" in entry && entry.truncated),
            "usage" in entry ? JSON.stringify(entry.usage) : null,
          );
      }
      if (rows.length > 0)
        this.ctx.graph.db
          .query(sql`
        UPDATE run_activity SET last_observed_at = ?, event_count = event_count + ? WHERE id = ?
      `)
          .run(this.ctx.clock.now(), rows.length, stream.id);
      if (input.event === "session-end" && run.attributes[agentAttributes.external] === true)
        this.end(stream.id);
    }, this.authority);
  }

  settle(run: Node): void {
    const reference = run.attributes[agentAttributes.activity];
    if (typeof reference === "string") this.end(reference);
  }

  read(input: ActivityRead) {
    if (input.operation === "peek") return this.peek(this.resolve(input.id), input.limit);
    const stream = input.id === undefined ? null : this.resolve(input.id);
    const search =
      input.operation === "search"
        ? sql`
      AND sequence IN (SELECT rowid FROM run_activity_search WHERE run_activity_search MATCH ?)
    `
        : "";
    const parameters: (string | number)[] =
      stream === null ? [input.after] : [stream.id, input.after];
    if (input.operation === "search") parameters.push(`"${input.query.replaceAll('"', '""')}"`);
    parameters.push(input.limit + 1);
    const page = events.parse(
      this.ctx.graph.db
        .query(sql`
      SELECT ${eventColumns} FROM run_activity_events
      WHERE ${stream === null ? "1 = 1" : "activity_id = ?"} AND sequence > ? ${search} ORDER BY sequence LIMIT ?
    `)
        .all(...parameters),
    );
    const selected = page.slice(0, input.limit);
    return {
      stream,
      events: selected,
      nextCursor: page.length > input.limit ? (selected.at(-1)?.sequence ?? null) : null,
    };
  }

  start(): void {
    for (const row of headers.parse(
      this.ctx.graph.db
        .query(sql`
      SELECT ${headerColumns} FROM run_activity WHERE expires_at IS NOT NULL AND expired_at IS NULL
    `)
        .all(),
    )) {
      if (row.expiresAt !== null && row.expiresAt <= this.ctx.clock.now()) this.expire(row.id);
      else if (row.expiresAt !== null) this.schedule(row.id, row.expiresAt);
    }
  }

  // -- Private helpers --

  private resolve(id: string) {
    const run = this.ctx.graph.all({
      where: q.and(q.eq("id", id), q.eq(q.attr(agentAttributes.run), true)),
      lean: false,
    })[0];
    const handle = run === undefined ? id : run.attributes[agentAttributes.activity];
    if (typeof handle !== "string")
      throw new Fault("activity", "Run has no activity for its current invocation");
    const row = this.ctx.graph.db
      .query(sql`
      SELECT ${headerColumns} FROM run_activity
      WHERE id = ? OR identity = ? ORDER BY rowid DESC LIMIT 1
    `)
      .get(handle, id);
    if (row === null)
      throw new Fault("activity", "No run activity for this handle, run or identity");
    return runActivityStreamSchema.parse(row);
  }

  private peek(stream: z.infer<typeof runActivityStreamSchema>, pageLimit: number) {
    const recent = events
      .parse(
        this.ctx.graph.db
          .query(sql`
        SELECT ${eventColumns} FROM run_activity_events
        WHERE activity_id = ? ORDER BY sequence DESC LIMIT ?
      `)
          .all(stream.id, pageLimit),
      )
      .toReversed();
    const tools = events.parse(
      this.ctx.graph.db
        .query(sql`
        SELECT ${eventColumns} FROM run_activity_events AS started
        WHERE activity_id = ? AND kind = 'tool-started'
          AND NOT EXISTS (SELECT 1 FROM run_activity_events AS ended
            WHERE ended.activity_id = started.activity_id AND ended.kind = 'tool-ended'
              AND ended.call_id = started.call_id)
          AND NOT EXISTS (SELECT 1 FROM run_activity_events AS boundary
            WHERE boundary.activity_id = started.activity_id
              AND boundary.kind IN ('turn-ended', 'session-ended')
              AND boundary.sequence > started.sequence)
        ORDER BY sequence DESC LIMIT ?
      `)
        .all(stream.id, pageLimit),
    );
    const latestUsage =
      events.parse(
        this.ctx.graph.db
          .query(sql`
        SELECT ${eventColumns} FROM run_activity_events
        WHERE activity_id = ? AND kind = 'usage' ORDER BY sequence DESC LIMIT 1
      `)
          .all(stream.id),
      )[0]?.usage ?? null;
    return {
      stream,
      latestUsage,
      observedAgoMs:
        stream.lastObservedAt === null ? null : this.ctx.clock.now() - stream.lastObservedAt,
      outstandingTools: tools,
      recent,
    };
  }

  private header(id: string) {
    return runActivityStreamSchema.parse(
      this.ctx.graph.db
        .query(sql`
      SELECT ${headerColumns} FROM run_activity WHERE id = ?
    `)
        .get(id),
    );
  }

  private end(id: string): void {
    this.ctx.graph.atomic(() => {
      const at = this.ctx.clock.now();
      const { changes } = this.ctx.graph.db
        .query(sql`
        UPDATE run_activity SET ended_at = ?, expires_at = ? WHERE id = ? AND ended_at IS NULL
      `)
        .run(at, at + this.retentionMs, id);
      if (changes > 0) this.schedule(id, at + this.retentionMs);
    }, this.authority);
  }

  private schedule(id: string, at: number): void {
    this.ctx.scheduler.schedule(`agents/activity/${id}`, at, "agents/activity-expire", { id });
  }

  private expire(id: string): void {
    this.ctx.graph.atomic(() => {
      const at = this.ctx.clock.now();
      const { changes } = this.ctx.graph.db
        .query(sql`
        UPDATE run_activity SET expired_at = ? WHERE id = ? AND expired_at IS NULL AND expires_at <= ?
      `)
        .run(at, id, at);
      if (changes === 0) return;
      this.ctx.graph.db.query(sql`DELETE FROM run_activity_events WHERE activity_id = ?`).run(id);
      this.ctx.scheduler.cancel(`agents/activity/${id}`);
    }, this.authority);
  }
}
