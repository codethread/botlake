import { jsonSchema, defineOp, q, type Context, type Node } from "@botlake/core";
import { agentMetadata, registrationSchema, sessionAudience } from "@botlake/native-session";
import { match } from "ts-pattern";
import { z } from "zod";

import { runStateSchema, startSchema, type Agents } from "./runs.ts";

const text = z.compile(z.string().min(1));
const listSchema = z.compile(
  z.strictObject({
    command: z.literal("list"),
    state: runStateSchema.optional(),
    limit: z.number().int().min(1).max(100).default(20),
    offset: z.number().int().min(0).default(0),
  }),
);

export function registerAgent(ctx: Context, service: Agents): void {
  const input = z.compile(
    z.discriminatedUnion("command", [
      startSchema.extend({ command: z.literal("start") }),
      listSchema,
      z.strictObject({ command: z.literal("show"), id: text }),
      z.strictObject({
        command: z.literal("catalog"),
        name: text.optional(),
        all: z.boolean().optional(),
      }),
      z.strictObject({ command: z.literal("reconcile") }),
      z.strictObject({ command: z.literal("cancel"), id: text }),
      z.strictObject({ command: z.literal("retry"), id: text }),
      z.strictObject({
        command: z.literal("resume"),
        id: text,
        prompt: text,
        requestId: text.optional(),
      }),
      z.strictObject({ command: z.literal("acknowledge"), id: text }),
      registrationSchema.safeExtend({ command: z.literal("native") }),
    ]),
  );

  ctx.register(
    defineOp({
      name: "agent",
      primer:
        'Use catalog to select a seat; --all includes unavailable seats, and catalog NAME expands settings and reasons. Providers require explicit agentFlags configuration. Flags affect new selection, not accepted settings, retry or resume. Start with seat, cwd and prompt; start/retry/resume/cancel return id, state, substatus and settled. List returns paged summaries; show RUN_ID (or base show) expands the full record. Native/output observations are not liveness. With Batteries selected, wait using bl await --query agent-run-settled --params \'{"runId":"RUN_ID"}\' --min-count 1. Check reason=satisfied, then agent show RUN_ID for agent/substatus, result and error; settled includes failure and cancellation, while closed/stopped alone does not prove settled custody. Wait timeout or interruption does not stop the agent. Process completion does not complete tasks; external sessions have no settlement guarantee or stop authority.',
      input,
      output: jsonSchema,
      cli: {
        description: "Tracked agent runs and native registration",
        examples: [
          "bl agent catalog",
          "bl agent catalog --all",
          "bl agent catalog reviewer",
          "bl agent list",
          "bl agent show RUN_ID",
          'bl await --query agent-run-settled --params \'{"runId":"RUN_ID"}\' --min-count 1',
        ],
        commands: {
          list: {
            description: "Paged run summaries; use show ID for full details",
            flags: {
              state: {
                type: "string",
                description: "Agent state: ready, running, stopped, failed or external",
              },
              limit: { type: "number", description: "Page size (default 20, maximum 100)" },
              offset: {
                type: "number",
                description: "Continue at nextOffset; pages are not a snapshot",
              },
            },
          },
          catalog: {
            description:
              "Available seats; name expands candidates, settings and unavailability reasons",
            positionals: [{ name: "name", type: "string" }],
            flags: {
              all: { type: "boolean", description: "Include unavailable seats" },
            },
          },
          reconcile: { description: "Reconcile custody; acknowledge the pass, not run settlement" },
          show: {
            description: "Full run record, including prompts, settings, result and custody",
            positionals: [{ name: "id", type: "string", required: true }],
          },
          cancel: {
            description: "Cancel owned process; return run status",
            positionals: [{ name: "id", type: "string", required: true }],
          },
          retry: {
            description: "Retry settled failure; return current run status",
            positionals: [{ name: "id", type: "string", required: true }],
          },
          acknowledge: {
            description: "Release retained process evidence; return id and acknowledged",
            positionals: [{ name: "id", type: "string", required: true }],
          },
          resume: {
            description: "Resume verified session; return new run status",
            positionals: [
              { name: "id", type: "string", required: true },
              { name: "prompt", type: "string", required: true },
            ],
            flags: { "request-id": { key: "requestId", type: "string" } },
          },
          native: {
            description: "Observe native session activity; optionally link a managed invocation",
            flags: {
              provider: { type: "string", required: true },
              "native-session-id": { key: "nativeSessionId", type: "string", required: true },
              cwd: { type: "string", required: true },
              "run-id": { key: "runId", type: "string" },
              invocation: { type: "string" },
              "parent-native-session-id": { key: "parentNativeSessionId", type: "string" },
              audience: {
                type: "string",
                description: "Intended recipient (human, agent or unknown)",
              },
              event: { type: "string" },
              "native-event": { key: "nativeEvent", type: "string" },
              "session-path": { key: "sessionPath", type: "string" },
              capabilities: { type: "string", multiple: true },
              "agent-seat": {
                key: "agentSeat",
                type: "string",
                description: "Seat (defaults to BL_AGENT_SEAT)",
              },
              model: { type: "string", description: "Model (defaults to BL_MODEL)" },
              "thinking-level": {
                key: "thinkingLevel",
                type: "string",
                description: "Effort (defaults to BL_EFFORT)",
              },
            },
          },
          start: {
            description: "Create run; return id, state, substatus and settled",
            flags: {
              seat: { type: "string", required: true },
              cwd: { type: "string", required: true },
              prompt: { type: "string", required: true },
              target: { type: "string" },
              "request-id": { key: "requestId", type: "string" },
            },
          },
        },
      },
      async handler(value) {
        const result = await match(value)
          .with({ command: "start" }, async (commandInput) => {
            const { command: _, ...request } = commandInput;
            const run = service.start(request);
            await service.reconcile();

            return runStatus(ctx.graph.show(run.id));
          })
          .with({ command: "list" }, (request) => listRuns(ctx, request))
          .with({ command: "show" }, ({ id }) => ctx.graph.show(id))
          .with({ command: "catalog" }, ({ name, all }) => service.catalog(name, all))
          .with({ command: "reconcile" }, async () => {
            await service.reconcile();

            return { reconciled: true };
          })
          .with({ command: "cancel" }, async ({ id }) => runStatus(await service.cancel(id)))
          .with({ command: "retry" }, async ({ id }) => {
            const run = service.retry(id);
            await service.reconcile();

            return runStatus(ctx.graph.show(run.id));
          })
          .with({ command: "resume" }, async ({ id, prompt, requestId }) => {
            const run = service.resume(id, prompt, requestId);
            await service.reconcile();

            return runStatus(ctx.graph.show(run.id));
          })
          .with({ command: "acknowledge" }, async ({ id }) => {
            const run = await service.acknowledge(id);

            return { id: run.id, acknowledged: run.attributes["agent/acknowledged"] };
          })
          .with({ command: "native" }, (commandInput) => {
            const { command: _, ...request } = commandInput;

            return service.native({
              ...request,
              ...agentMetadata(request, ctx.env.bl),
              audience: sessionAudience(request, ctx.env.bl),
            });
          })
          .exhaustive();

        return jsonSchema.parse(result);
      },
    }),
  );
}

// -- Private helpers --

function runStatus(run: Node) {
  return {
    id: run.id,
    state: run.attributes["agent/state"],
    substatus: run.attributes["agent/substatus"] ?? null,
    // External sessions have no custody settlement observation.
    settled: run.attributes["agent/settled"] ?? null,
  };
}

function listRuns(ctx: Context, { state, limit, offset }: z.infer<typeof listSchema>) {
  const tracked = q.eq(q.attr("agent/run"), true);
  const runs = ctx.graph.all({
    where: state === undefined ? tracked : q.and(tracked, q.eq(q.attr("agent/state"), state)),
    lean: false,
  });
  const page = runs.slice(offset, offset + limit);

  return {
    runs: page.map((run) => ({
      ...runStatus(run),
      seat: run.attributes["agent/seat"] ?? null,
      provider: run.attributes["agent/provider"],
      identity: run.attributes["agent/identity"] ?? null,
    })),
    total: runs.length,
    nextOffset: offset + page.length < runs.length ? offset + page.length : null,
  };
}
