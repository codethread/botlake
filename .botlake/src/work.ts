import { defineProbe } from "@botlake/extension-work";
import { configureWork } from "ct-config";
import { z } from "zod";

const delay = defineProbe({
  name: "delay",
  description: "Wait for a duration such as 2m or 10s (at most 5 minutes).",
  params: z
    .strictObject({
      duration: z
        .string()
        .regex(/^[1-9]\d*(s|m)$/u)
        .refine((value) => durationMs(value) <= 300_000, "Delay must be at most 5 minutes"),
      readyAt: z.iso.datetime().optional(),
    })
    .transform(({ duration, readyAt }) => ({
      duration,
      // Persist the deadline so lake restarts do not restart the delay.
      readyAt: readyAt ?? new Date(Date.now() + durationMs(duration)).toISOString(),
    })),
  policy: { everyMs: 5_000, maxAttempts: 65, timeoutMs: 2_000 },
  async run({ readyAt }) {
    return Date.now() >= Date.parse(readyAt)
      ? { outcome: "passed", message: `Delay elapsed at ${readyAt}` }
      : { outcome: "failed", message: `Waiting until ${readyAt}` };
  },
});

export default configureWork({ probes: [delay] });

function durationMs(value: string): number {
  return Number(value.slice(0, -1)) * (value.endsWith("m") ? 60_000 : 1_000);
}
