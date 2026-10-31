import { jsonSchema, defineOp, q, type Context, type Node } from "@botlake/core";
import { registrationSchema } from "@botlake/native-session";
import { match } from "ts-pattern";
import { z } from "zod";

import { activityReadSchema } from "./activity.ts";
import { agentAttributes, agentRunStateSchema } from "./node-model.ts";
import { startSchema, type Agents } from "./runs.ts";

const text = z.compile(z.string().min(1));
const listSchema = z.compile(
  z.strictObject({
    command: z.literal("list"),
    state: agentRunStateSchema.optional(),
    limit: z.number().int().min(1).max(100).default(20),
    offset: z.number().int().min(0).default(0),
  }),
);
const [listActivity, searchActivity, peekActivity] = activityReadSchema.options;
const activityCommand = { command: z.literal("activity") };

export function registerAgent(ctx: Context, service: Agents): void {
  const input = z.compile(
    z.discriminatedUnion("command", [
      startSchema.extend({ command: z.literal("start") }),
      listSchema,
      z.strictObject({ command: z.literal("show"), id: text }),
      z.discriminatedUnion("operation", [
        listActivity.extend(activityCommand),
        searchActivity.extend(activityCommand),
        peekActivity.extend(activityCommand),
      ]),
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
      about:
        "Managed runs own process custody and an invocation-fenced lifecycle. Settlement includes failure and cancellation, independently of task completion. External native sessions supply observations without stop authority; activity and output observations do not prove process liveness. Retries and resumes retain accepted provider settings.",
      primer:
        'Select a seat with bl agent catalog, then bl agent start --seat SEAT --cwd DIR --prompt TEXT. Keep the returned id. With Batteries selected, wait using bl await --query agent-run-settled --params \'{"runId":"RUN_ID"}\' --min-count 1; check reason=satisfied, then bl agent show RUN_ID for the result or error. Wait timeout does not stop the agent. Use bl agent activity peek RUN_ID for recent observations or bl agent activity search QUERY for retained excerpts; follow the native transcript reference for the complete record. Completing the process does not close its task.',
      input,
      output: jsonSchema,
      jsonSchema: { input, output: jsonSchema },
      cli: {
        description: "Tracked agent runs and native registration",
        examples: [
          "bl agent catalog",
          "bl agent catalog --all",
          "bl agent catalog reviewer",
          "bl agent list",
          "bl agent show RUN_ID",
          "bl agent activity peek RUN_ID",
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
          activity: {
            description: "List, search or inspect plugin-observed run activity",
            selector: "operation",
            commands: {
              list: {
                description: "Page retained events for a target, or all streams",
                positionals: [{ name: "target", key: "id", type: "string" }],
                flags: {
                  after: { type: "number", description: "Continue at nextCursor" },
                  limit: { type: "number", description: "Page size (default 20, maximum 100)" },
                },
              },
              search: {
                description: "Search an excerpt phrase across all streams or one target",
                positionals: [{ name: "query", type: "string", required: true }],
                flags: {
                  target: {
                    key: "id",
                    type: "string",
                    description: "Run, identity or activity handle",
                  },
                  after: { type: "number", description: "Continue at nextCursor" },
                  limit: { type: "number", description: "Page size (default 20, maximum 100)" },
                },
              },
              peek: {
                description: "Inspect recent events, outstanding tools and latest usage",
                positionals: [{ name: "target", key: "id", type: "string", required: true }],
                flags: {
                  limit: {
                    type: "number",
                    description: "Recent events/tools (default 20, maximum 100)",
                  },
                },
              },
            },
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
          .with({ command: "activity" }, (request) => service.readActivity(request))
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

            return { id: run.id, acknowledged: run.attributes[agentAttributes.acknowledged] };
          })
          .with({ command: "native" }, (commandInput) => {
            const { command: _, ...request } = commandInput;

            return service.native(request);
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
    state: run.attributes[agentAttributes.state],
    substatus: run.attributes[agentAttributes.substatus] ?? null,
    // External sessions have no custody settlement observation.
    settled: run.attributes[agentAttributes.settled] ?? null,
  };
}

function listRuns(ctx: Context, { state, limit, offset }: z.infer<typeof listSchema>) {
  const tracked = q.eq(q.attr(agentAttributes.run), true);
  const runs = ctx.graph.all({
    where:
      state === undefined ? tracked : q.and(tracked, q.eq(q.attr(agentAttributes.state), state)),
    lean: false,
  });
  const page = runs.slice(offset, offset + limit);

  return {
    runs: page.map((run) => ({
      ...runStatus(run),
      seat: run.attributes[agentAttributes.seat] ?? null,
      provider: run.attributes[agentAttributes.provider],
      identity: run.attributes[agentAttributes.identity] ?? null,
    })),
    total: runs.length,
    nextOffset: offset + page.length < runs.length ? offset + page.length : null,
  };
}
