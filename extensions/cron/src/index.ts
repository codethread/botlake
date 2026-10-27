import {
  sql,
  encode,
  Fault,
  defineOp,
  type Json,
  type Context,
  type Extension,
} from "@botlake/core";
import { CronExpressionParser } from "cron-parser";
import { z } from "zod";

const scheduleSchema = z.union([
  z.strictObject({ everyMs: z.number().int().positive() }),
  z.strictObject({ expression: z.string().min(1), timezone: z.string().min(1) }),
]);

const jobSchema = z.strictObject({
  id: z.string().min(1),
  action: z.string().min(1),
  version: z.string().min(1).default("1"),
  schedule: scheduleSchema,
  payload: z.json().default({}),
  overlap: z.enum(["skip", "queue", "allow"]).default("skip"),
  missed: z.enum(["skip", "once", "catch-up"]).default("once"),
  retry: z
    .strictObject({
      attempts: z.number().int().nonnegative(),
      delayMs: z.number().int().positive(),
    })
    .default({ attempts: 0, delayMs: 1000 }),
});

export type Job = z.infer<typeof jobSchema>;

export interface Occurrence {
  id: string;
  job: string;
  scheduledAt: number;
  attempt: number;
  payload: Json;
}

export type Action = (ctx: Context, occurrence: Occurrence) => Promise<Json | void> | Json | void;

export function nextFire(schedule: Job["schedule"], after: number): number {
  if ("everyMs" in schedule) return after + schedule.everyMs;

  new Intl.DateTimeFormat("en", { timeZone: schedule.timezone }).format(0);

  return CronExpressionParser.parse(schedule.expression, {
    currentDate: after,
    tz: schedule.timezone,
  })
    .next()
    .getTime();
}

export function defineJob(input: z.input<typeof jobSchema>): Job {
  const job = jobSchema.parse(input);

  nextFire(job.schedule, 0);

  return job;
}

const persistedJob = z.object({
  id: z.string(),
  spec: z.string(),
  next_at: z.number(),
  enabled: z.number(),
});

const occurrenceSchema = z.object({
  id: z.string(),
  job: z.string(),
  scheduled_at: z.number(),
  status: z.enum(["pending", "running", "succeeded", "failed", "skipped"]),
  attempt: z.number(),
  retry_at: z.number().nullable(),
  result: z.string().nullable(),
  error: z.string().nullable(),
});

export class Cron {
  private readonly jobs = new Map<string, Job>();
  private readonly active = new Map<string, Promise<void>>();
  private stopping = false;
  private readonly runningJobs = new Map<string, string>();

  constructor(
    private readonly ctx: Context,
    jobs: Job[],
    private readonly actions: Record<string, Action>,
  ) {
    ctx.graph.db.run(sql`
      CREATE TABLE IF NOT EXISTS cron_jobs (
        id TEXT PRIMARY KEY,
        spec TEXT NOT NULL,
        next_at INTEGER NOT NULL,
        enabled INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS cron_occurrences (
        id TEXT PRIMARY KEY,
        job TEXT NOT NULL REFERENCES cron_jobs(id),
        scheduled_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 0,
        retry_at INTEGER,
        result TEXT,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS cron_due ON cron_occurrences(status, retry_at);
    `);
    for (const input of jobs) {
      const job = defineJob(input);
      if (this.jobs.has(job.id)) throw new Fault("collision", `Duplicate cron job: ${job.id}`);

      if (actions[job.action] === undefined)
        throw new Fault("dependency", `Unknown cron action: ${job.action}`);
      this.jobs.set(job.id, job);
    }
    ctx.scheduler.register("cron/fire", (wake) => {
      const input = z.object({ job: z.string() }).parse(wake.payload);
      this.fire(input.job);
    });
    ctx.scheduler.register("cron/retry", () => {
      this.dispatch();
    });
  }

  start(): void {
    const now = this.ctx.clock.now();
    this.ctx.graph.atomic(() => {
      for (const old of z.array(persistedJob).parse(
        this.ctx.graph.db
          .query(sql`
            SELECT *
            FROM cron_jobs
          `)
          .all(),
      ))
        if (!this.jobs.has(old.id)) {
          this.ctx.graph.db
            .query(sql`
              UPDATE cron_jobs
              SET enabled = 0
              WHERE id = ?
            `)
            .run(old.id);
          this.ctx.scheduler.cancel(`cron/${old.id}`);
          this.ctx.graph.db
            .query(sql`
              UPDATE cron_occurrences
              SET status = 'skipped',
                  error = 'job removed'
              WHERE job = ?
                AND status IN ('pending', 'running')
            `)
            .run(old.id);
        }
      for (const job of this.jobs.values()) {
        const spec = encode(job);
        const raw = this.ctx.graph.db
          .query(sql`
            SELECT *
            FROM cron_jobs
            WHERE id = ?
          `)
          .get(job.id);
        const old = raw === null ? undefined : persistedJob.parse(raw);
        const next =
          old?.spec === spec && old.enabled === 1 ? old.next_at : nextFire(job.schedule, now);
        if (old !== undefined && old.spec !== spec)
          this.ctx.graph.db
            .query(sql`
              UPDATE cron_occurrences
              SET status = 'skipped',
                  error = 'job changed'
              WHERE job = ?
                AND status IN ('pending', 'running')
            `)
            .run(job.id);
        this.ctx.graph.db
          .query(sql`
            INSERT INTO cron_jobs
            VALUES (?, ?, ?, 1)
            ON CONFLICT (id) DO UPDATE SET
              spec = excluded.spec,
              next_at = excluded.next_at,
              enabled = 1
          `)
          .run(job.id, spec, next);
        this.ctx.scheduler.schedule(`cron/${job.id}`, next, "cron/fire", { job: job.id });
      }
      this.ctx.graph.db
        .query(sql`
          UPDATE cron_occurrences
          SET status = 'pending',
              retry_at = ?
          WHERE status = 'running'
        `)
        .run(now);
    });
    this.dispatch();
  }

  private fire(id: string): void {
    const job = this.jobs.get(id);
    if (job === undefined || this.stopping) return;

    const stored = persistedJob.parse(
      this.ctx.graph.db
        .query(sql`
          SELECT *
          FROM cron_jobs
          WHERE id = ?
        `)
        .get(id),
    );
    const now = this.ctx.clock.now();
    if (stored.next_at > now) return;

    this.ctx.graph.atomic(() => {
      let at = stored.next_at;
      if (job.missed !== "catch-up") {
        if ("everyMs" in job.schedule)
          at += Math.floor((now - at) / job.schedule.everyMs) * job.schedule.everyMs;
        else
          at = Math.max(
            at,
            CronExpressionParser.parse(job.schedule.expression, {
              currentDate: now + 1,
              tz: job.schedule.timezone,
            })
              .prev()
              .getTime(),
          );
      }
      let count = 0;
      do {
        const occurrence = `${job.id}/${at}`;
        const missed = job.missed === "skip" && nextFire(job.schedule, stored.next_at) <= now;
        this.ctx.graph.db
          .query(sql`
            INSERT OR IGNORE INTO cron_occurrences (id, job, scheduled_at, status, error)
            VALUES (?, ?, ?, ?, ?)
          `)
          .run(occurrence, id, at, missed ? "skipped" : "pending", missed ? "missed" : null);
        at = nextFire(job.schedule, at);
        count++;
      } while (job.missed === "catch-up" && at <= now && count < 1000);
      this.ctx.graph.db
        .query(sql`
          UPDATE cron_jobs
          SET next_at = ?
          WHERE id = ?
        `)
        .run(at, id);
      this.ctx.scheduler.schedule(`cron/${id}`, at, "cron/fire", { job: id });
    });
    this.dispatch();
  }

  private dispatch(): void {
    if (this.stopping) return;

    const rows = z.array(occurrenceSchema).parse(
      this.ctx.graph.db
        .query(sql`
          SELECT *
          FROM cron_occurrences
          WHERE status = 'pending'
            AND (retry_at IS NULL OR retry_at <= ?)
          ORDER BY scheduled_at, id
        `)
        .all(this.ctx.clock.now()),
    );
    for (const occurrence of rows) {
      if (this.active.has(occurrence.id)) continue;

      const job = this.jobs.get(occurrence.job);
      if (job === undefined) continue;

      const busy = [...this.runningJobs.values()].includes(job.id);
      if (busy && job.overlap !== "allow") {
        if (job.overlap === "skip" && occurrence.attempt === 0)
          this.ctx.graph.db
            .query(sql`
              UPDATE cron_occurrences
              SET status = 'skipped',
                  error = 'overlap'
              WHERE id = ?
            `)
            .run(occurrence.id);
        continue;
      }
      this.ctx.graph.db
        .query(sql`
          UPDATE cron_occurrences
          SET status = 'running',
              attempt = attempt + 1,
              retry_at = NULL
          WHERE id = ?
        `)
        .run(occurrence.id);
      this.runningJobs.set(occurrence.id, job.id);
      const task = this.execute(job, {
        id: occurrence.id,
        job: job.id,
        scheduledAt: occurrence.scheduled_at,
        attempt: occurrence.attempt + 1,
        payload: job.payload,
      }).finally(() => {
        this.active.delete(occurrence.id);
        this.runningJobs.delete(occurrence.id);
        this.dispatch();
      });
      this.active.set(occurrence.id, task);
    }
    const retry = z.object({ at: z.number().nullable() }).parse(
      this.ctx.graph.db
        .query(sql`
          SELECT min(retry_at) as at
          FROM cron_occurrences
          WHERE status = 'pending'
            AND retry_at > ?
        `)
        .get(this.ctx.clock.now()),
    );
    if (retry.at !== null) this.ctx.scheduler.schedule("cron/retry", retry.at, "cron/retry");
  }

  private async execute(job: Job, occurrence: Occurrence): Promise<void> {
    try {
      const action = this.actions[job.action];
      if (action === undefined) throw new Fault("dependency", `Unknown action ${job.action}`);

      const result = await action(this.ctx, occurrence);
      this.ctx.graph.db
        .query(sql`
          UPDATE cron_occurrences
          SET status = 'succeeded',
              result = ?,
              error = NULL
          WHERE id = ?
        `)
        .run(encode(result ?? null), occurrence.id);
    } catch (error) {
      const retry = occurrence.attempt <= job.retry.attempts;
      this.ctx.graph.db
        .query(sql`
          UPDATE cron_occurrences
          SET status = ?,
              retry_at = ?,
              error = ?
          WHERE id = ?
        `)
        .run(
          retry ? "pending" : "failed",
          retry ? this.ctx.clock.now() + job.retry.delayMs : null,
          String(error),
          occurrence.id,
        );
    }
  }

  status(): unknown[] {
    return this.ctx.graph.db
      .query(sql`
        SELECT *
        FROM cron_jobs
        ORDER BY id
      `)
      .all();
  }

  history(job?: string): unknown[] {
    return this.ctx.graph.db
      .query(sql`
        SELECT *
        FROM cron_occurrences
        WHERE (? IS NULL OR job = ?)
        ORDER BY scheduled_at, id
      `)
      .all(job ?? null, job ?? null);
  }

  async drain(): Promise<void> {
    while (this.active.size > 0) await Promise.all(this.active.values());
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.drain();
  }
}

export function cron(options: { jobs: Job[]; actions: Record<string, Action> }): Extension {
  return {
    name: "cron",
    activate(ctx) {
      const service = new Cron(ctx, options.jobs, options.actions);
      ctx.resource(service);
      ctx.register(
        defineOp({
          name: "cron",
          primer:
            "Select a local module exporting cron({jobs, actions}); define inert jobs with defineJob. Inspect status for the next fire and history for occurrence outcomes. Unchanged definitions retain cadence. Crash recovery is at least once: deduplicate external effects using the occurrence id.",
          input: z.discriminatedUnion("command", [
            z.strictObject({ command: z.literal("status") }),
            z.strictObject({ command: z.literal("history"), job: z.string().optional() }),
          ]),
          output: z.json(),
          cli: {
            description: "Durable schedules and occurrence history",
            examples: ["bl cron status", "bl cron history --job JOB_ID"],
            commands: {
              status: { description: "Schedules" },
              history: { description: "Occurrences", flags: { job: { type: "string" } } },
            },
          },
          handler: (input) =>
            z
              .json()
              .parse(input.command === "status" ? service.status() : service.history(input.job)),
        }),
      );
    },
  };
}

export function jobJsonSchema(): unknown {
  return z.toJSONSchema(jobSchema, { io: "input" });
}

export default cron({ jobs: [], actions: {} });
