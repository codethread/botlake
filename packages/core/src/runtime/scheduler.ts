import { z } from "zod";

import { decode, encode, Fault, type Json } from "../core/json.ts";
import { sql } from "../core/sql.ts";
import type { Graph } from "../core/store.ts";
import type { Clock } from "./clock.ts";

const wakeSchema = z.compile(
  z.strictObject({
    key: z.string(),
    at: z.number(),
    handler: z.string(),
    payload: z.string(),
    generation: z.string(),
    attempts: z.number(),
  }),
);

const wakeTimeSchema = z.compile(z.number().int());
const wakesSchema = z.compile(z.array(wakeSchema));

export type Wake = Omit<z.infer<typeof wakeSchema>, "payload"> & { payload: Json };

export class Scheduler {
  private readonly handlers = new Map<string, (wake: Wake) => Promise<void> | void>();
  private cancelTimer: (() => void) | undefined;
  private active = false;
  private readonly running = new Set<Promise<void>>();
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly graph: Graph,
    private readonly clock: Clock,
    private readonly failure: (error: unknown) => void,
  ) {}

  register(name: string, handler: (wake: Wake) => Promise<void> | void): void {
    if (this.handlers.has(name)) throw new Fault("collision", `Duplicate wake handler: ${name}`);

    this.handlers.set(name, handler);
  }

  schedule(key: string, at: number, handler: string, payload: Json = {}): string {
    wakeTimeSchema.parse(at);
    if (!this.handlers.has(handler))
      throw new Fault("dependency", `Unknown wake handler: ${handler}`);

    const generation = crypto.randomUUID();
    this.graph.atomic(() => {
      this.graph.db
        .query(sql`
          INSERT INTO wakes
          VALUES (?, ?, ?, ?, ?, 0)
          ON CONFLICT (key) DO UPDATE SET
            at = excluded.at,
            handler = excluded.handler,
            payload = excluded.payload,
            generation = excluded.generation,
            attempts = 0
        `)
        .run(key, at, handler, encode(payload), generation);
      this.graph.afterCommit(() => {
        this.arm();
      });
    });

    return generation;
  }

  cancel(key: string): boolean {
    return this.graph.atomic(() => {
      const wake = this.graph.db
        .query(sql`
          SELECT *
          FROM wakes
          WHERE key = ?
        `)
        .get(key);
      if (wake === null) return false;

      const parsed = wakeSchema.parse(wake);
      this.graph.db
        .query(sql`
          DELETE FROM wakes
          WHERE key = ?
        `)
        .run(key);
      this.graph.db
        .query(sql`
          INSERT INTO wake_history (key, generation, status, at)
          VALUES (?, ?, 'cancelled', ?)
        `)
        .run(key, parsed.generation, this.clock.now());
      this.graph.afterCommit(() => {
        this.arm();
      });
      return true;
    });
  }

  pending(): Wake[] {
    return wakesSchema
      .parse(
        this.graph.db
          .query(sql`
            SELECT *
            FROM wakes
            ORDER BY at, key
          `)
          .all(),
      )
      .map((wake) => ({ ...wake, payload: decode(wake.payload) }));
  }

  history(): unknown[] {
    return this.graph.db
      .query(sql`
        SELECT *
        FROM wake_history
        ORDER BY sequence
      `)
      .all();
  }

  validate(): void {
    for (const wake of this.pending())
      if (!this.handlers.has(wake.handler))
        throw new Fault("dependency", `Unknown persisted wake handler: ${wake.handler}`);
  }

  start(): void {
    this.validate();
    this.active = true;
    this.arm();
  }

  tick(): void {
    if (!this.active) return;

    const now = this.clock.now();
    for (const wake of this.pending().filter(
      (entry) => entry.at <= now && !this.inFlight.has(`${entry.key}/${entry.generation}`),
    )) {
      const identity = `${wake.key}/${wake.generation}`;
      const claim = this.graph.db
        .query(sql`
          UPDATE wakes
          SET at = ?,
              attempts = attempts + 1
          WHERE key = ?
            AND generation = ?
        `)
        .run(now + 1000, wake.key, wake.generation);
      if (claim.changes === 0) continue;

      this.inFlight.add(identity);
      const task = this.deliver(wake).finally(() => {
        this.running.delete(task);
        this.inFlight.delete(identity);
        this.arm();
      });
      this.running.add(task);
    }
    this.arm();
  }

  async drain(): Promise<void> {
    await Promise.all(this.running);
  }

  async stop(): Promise<void> {
    this.active = false;
    this.cancelTimer?.();
    await this.drain();
  }

  // -- Private helpers --

  private arm(): void {
    this.cancelTimer?.();
    if (!this.active) return;

    const first = this.pending().find(
      (wake) => !this.inFlight.has(`${wake.key}/${wake.generation}`),
    );
    if (first !== undefined)
      this.cancelTimer = this.clock.arm(first.at, () => {
        this.tick();
      });
  }

  private async deliver(wake: Wake): Promise<void> {
    try {
      const handler = this.handlers.get(wake.handler);
      if (handler === undefined)
        throw new Fault("dependency", `Unknown wake handler: ${wake.handler}`);
      await handler({ ...wake, attempts: wake.attempts + 1 });
      this.graph.atomic(() => {
        this.graph.db
          .query(sql`
            DELETE FROM wakes
            WHERE key = ?
              AND generation = ?
          `)
          .run(wake.key, wake.generation);
        this.graph.db
          .query(sql`
            INSERT INTO wake_history (key, generation, status, at)
            VALUES (?, ?, 'completed', ?)
          `)
          .run(wake.key, wake.generation, this.clock.now());
      });
    } catch (error) {
      this.graph.db
        .query(sql`
          INSERT INTO wake_history (key, generation, status, at, error)
          VALUES (?, ?, 'failed', ?, ?)
        `)
        .run(wake.key, wake.generation, this.clock.now(), String(error));
      this.failure(error);
    }
  }
}
