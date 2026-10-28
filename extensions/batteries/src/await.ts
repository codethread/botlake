import { attributesSchema, defineOp, Fault, type Clock, type Context } from "@botlake/core";
import { z } from "zod";

const inputSchema = z
  .strictObject({
    query: z.string().trim().min(1),
    params: attributesSchema.default({}),
    minCount: z.number().int().nonnegative().optional(),
    maxCount: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER - 1)
      .optional(),
    timeoutSecs: z.number().int().min(0).max(2_147_483).default(1800),
  })
  .refine((input) => input.minCount !== undefined || input.maxCount !== undefined, {
    message: "await requires --min-count or --max-count",
  })
  .refine(
    (input) =>
      input.minCount === undefined ||
      input.maxCount === undefined ||
      input.minCount <= input.maxCount,
    { message: "--min-count must not exceed --max-count" },
  )
  .refine((input) => input.minCount !== 0 || input.maxCount !== undefined, {
    message: "--min-count 0 alone is vacuous",
  });

const outputSchema = z.strictObject({
  operation: z.literal("await"),
  query: z.string(),
  reason: z.enum(["satisfied", "timeout"]),
  count: z.number().int().nonnegative(),
  countLimit: z.number().int().positive(),
  minCount: z.number().int().nonnegative().nullable(),
  maxCount: z.number().int().nonnegative().nullable(),
  elapsedMs: z.number().nonnegative(),
});

export function registerAwait(ctx: Context): void {
  ctx.register(
    defineOp({
      name: "await",
      input: inputSchema,
      output: outputSchema,
      jsonSchema: { input: inputSchema, output: outputSchema },
      deadline: "unbounded",
      primer:
        "Wait for a named query's result count to enter the inclusive min/max band. Checks immediately, then every second. Timeout is data (reason=timeout, exit 0); inspect reason before continuing. count is capped at countLimit, not a total. --timeout-secs 0 checks once. --timeout before await imposes a separate hard request deadline; interrupting or timing out a wait does not cancel agents or complete tasks. Active-set disappearance can mean closure, replacement or deletion, not success.",
      cli: {
        description: "Wait for a named query's result count to enter an inclusive band",
        examples: [
          'bl await --query node-closed --params \'{"id":"NODE_ID"}\' --min-count 1',
          'bl await --query children-active --params \'{"parent":"NODE_ID"}\' --max-count 0',
        ],
        flags: {
          query: { type: "string", required: true, description: "Registered query name" },
          params: { type: "json", description: "Named-query parameters" },
          "min-count": { key: "minCount", type: "number", description: "Inclusive minimum" },
          "max-count": { key: "maxCount", type: "number", description: "Inclusive maximum" },
          "timeout-secs": {
            key: "timeoutSecs",
            type: "number",
            description: "Wait budget in seconds (default 1800; 0 probes once; maximum 2147483)",
          },
        },
      },
      async handler(input, context, request): Promise<z.output<typeof outputSchema>> {
        const named = context.namedQuery(input.query);
        if (named === undefined) throw new Fault("query", `Unknown query: ${input.query}`);
        for (const param of named.params ?? [])
          if (input.params[param] === undefined)
            throw new Fault("query", `Missing parameter: ${param}`);
        for (const param of Object.keys(input.params))
          if (!(named.params ?? []).includes(param))
            throw new Fault("query", `Unknown parameter: ${param}`);

        const minCount = input.minCount ?? 0;
        const limit = input.maxCount === undefined ? minCount : input.maxCount + 1;
        const started = context.clock.now();
        const until = started + input.timeoutSecs * 1000;
        for (;;) {
          request.signal.throwIfAborted();
          const count = context.graph.count({ where: named.where, params: input.params, limit });
          const satisfied =
            count >= minCount && (input.maxCount === undefined || count <= input.maxCount);
          const now = context.clock.now();
          if (satisfied || now >= until)
            return {
              operation: "await",
              query: input.query,
              reason: satisfied ? "satisfied" : "timeout",
              count,
              countLimit: limit,
              minCount: input.minCount ?? null,
              maxCount: input.maxCount ?? null,
              elapsedMs: now - started,
            };
          await sleepUntil(context.clock, Math.min(now + 1000, until), request.signal);
        }
      },
    }),
  );
}

// -- Private helpers --

function sleepUntil(clock: Clock, at: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cancel = clock.arm(at, () => {
      signal.removeEventListener("abort", abort);
      resolve();
    });
    function abort(): void {
      cancel();
      signal.removeEventListener("abort", abort);
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Fault("cancelled", "Wait aborted", String(signal.reason)),
      );
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}
