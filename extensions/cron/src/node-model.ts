import { jsonSchema } from "@botlake/core";
import { z } from "zod";

/** Interval or calendar schedule accepted by a cron job. */
export const scheduleSchema = z.compile(
  z.union([
    z.strictObject({ everyMs: z.number().int().positive() }),
    z.strictObject({ expression: z.string().min(1), timezone: z.string().min(1) }),
  ]),
);

/** Job definition encoded as JSON in cron_jobs.spec. */
export const jobSchema = z.compile(
  z.strictObject({
    id: z.string().min(1),
    action: z.string().min(1),
    version: z.string().min(1).default("1"),
    schedule: scheduleSchema,
    payload: jsonSchema.default({}),
    overlap: z.enum(["skip", "queue", "allow"]).default("skip"),
    missed: z.enum(["skip", "once", "catch-up"]).default("once"),
    retry: z
      .strictObject({
        attempts: z.number().int().nonnegative(),
        delayMs: z.number().int().positive(),
      })
      .default({ attempts: 0, delayMs: 1000 }),
  }),
);

export type Job = z.infer<typeof jobSchema>;

/** Persisted cron_jobs row. */
export const persistedJob = z.compile(
  z.object({
    id: z.string(),
    spec: z.string(),
    next_at: z.number(),
    enabled: z.number(),
  }),
);

export const persistedJobsSchema = z.compile(z.array(persistedJob));

/** Persisted cron_occurrences row. */
export const occurrenceSchema = z.compile(
  z.object({
    id: z.string(),
    job: z.string(),
    scheduled_at: z.number(),
    status: z.enum(["pending", "running", "succeeded", "failed", "skipped"]),
    attempt: z.number(),
    retry_at: z.number().nullable(),
    result: z.string().nullable(),
    error: z.string().nullable(),
  }),
);

export const occurrencesSchema = z.compile(z.array(occurrenceSchema));
