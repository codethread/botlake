import { Fault, jsonSchema, defineOp, q, type Context, type Node } from "@botlake/core";
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
const showSchema = z.strictObject({
  command: z.literal("show"),
  id: text,
  showResult: z.boolean().default(false),
  showPrompt: z.boolean().default(false),
  showLaunch: z.boolean().default(false),
  showSettings: z.boolean().default(false),
  showError: z.boolean().default(false),
});
const [listActivity, searchActivity, peekActivity] = activityReadSchema.options;
const activityCommand = { command: z.literal("activity") };

export function registerAgent(ctx: Context, service: Agents): void {
  const input = z.compile(
    z.discriminatedUnion("command", [
      startSchema.extend({ command: z.literal("start") }),
      listSchema,
      showSchema,
      z.strictObject({ command: z.literal("follow"), id: text, fromWorkspace: text }),
      z.discriminatedUnion("operation", [
        listActivity.extend(activityCommand),
        searchActivity.extend(activityCommand),
        peekActivity.extend(activityCommand),
      ]),
      z
        .strictObject({
          command: z.literal("catalog"),
          name: text.optional(),
          all: z.boolean().optional(),
          showSystemPrompt: z.boolean().default(false),
        })
        .refine(
          (value) => !value.showSystemPrompt || value.name !== undefined,
          "--show-system-prompt requires a seat name",
        ),
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
      about: [
        "Managed runs own process custody. Settlement is independent of task completion.",
        "Native sessions and activity are observations, not custody or proof of liveness. Follow retains a summary; execution state and commands remain at the owner.",
        "Retries and resumes retain accepted provider settings.",
      ].join(" "),
      primer: [
        "Choose a seat with bl agent catalog [SEAT], then use bl agent start --seat SEAT --cwd DIR --prompt TEXT and keep the returned id.",
        `With Batteries, use bl await --query agent-run-settled --params '{"runId":"RUN_ID"}' --min-count 1. Check reason=satisfied before bl agent show RUN_ID.`,
        "A wait timeout does not stop the run. Settlement does not close a served task. Use activity peek for recent observations; the native transcript is the full record.",
        "Global --workspace selects the owner and its seats. Start's --cwd sets only the execution directory. Managed children inherit the owner's BL_WORKSPACE after cd.",
        "Use bl --workspace DEST agent start to record at DEST. Targets must be owned by the run's lake; imported references are read-only.",
        "agent follow RUN_ID --from-workspace OWNER retains a summary. Wait, inspect activity and control the run at OWNER using its original ID. See bl help agent start.",
      ].join(" "),
      input,
      output: jsonSchema,
      jsonSchema: { input, output: jsonSchema },
      cli: {
        description: "Managed agent runs and native session observations",
        examples: [
          "bl agent catalog",
          `bl agent start --seat reviewer --cwd "$PWD" --prompt 'Review the change'`,
          "bl agent list",
          "bl agent show RUN_ID",
          "bl agent activity peek RUN_ID",
          'bl await --query agent-run-settled --params \'{"runId":"RUN_ID"}\' --min-count 1',
        ],
        commands: {
          list: {
            description:
              "Return { runs, total, nextOffset } summaries; use show RUN_ID to inspect one run",
            examples: ["bl agent list", "bl agent list --state failed --limit 10"],
            flags: {
              state: {
                type: "string",
                description: "Filter: ready, running, stopped, failed or external",
              },
              limit: { type: "number", description: "Page size (default 20; range 1–100)" },
              offset: {
                type: "number",
                description:
                  "Start index (default 0; minimum 0); continue with nextOffset until null; pages are not snapshots",
              },
            },
          },
          catalog: {
            description:
              "List available seats; NAME shows routing, candidates and settings without prompt text",
            examples: ["bl agent catalog", "bl agent catalog reviewer", "bl agent catalog --all"],
            positionals: [{ name: "name", type: "string", description: "Optional seat to expand" }],
            flags: {
              all: {
                type: "boolean",
                description: "For a list, include unavailable seats and reasons",
              },
              "show-system-prompt": {
                key: "showSystemPrompt",
                type: "boolean",
                description:
                  "For NAME, include explicit candidate prompts; callbacks are marked dynamic, never evaluated",
              },
            },
          },
          reconcile: {
            description:
              "Reconcile process custody; returns { reconciled: true }, not run settlement",
            examples: ["bl agent reconcile"],
          },
          show: {
            description:
              "Show lifecycle, session and result/error availability; followed runs retain source provenance. Text and launch configuration are opt-in",
            examples: ["bl agent show RUN_ID", "bl agent show RUN_ID --show-result"],
            positionals: [{ name: "id", type: "string", required: true }],
            flags: {
              "show-launch": {
                key: "showLaunch",
                type: "boolean",
                description:
                  "Include the frozen process specification, including stdin and environment",
              },
              "show-settings": {
                key: "showSettings",
                type: "boolean",
                description: "Include resolved provider settings and system prompt",
              },
              "show-result": {
                key: "showResult",
                type: "boolean",
                description: "Include the exact provider result when available",
              },
              "show-prompt": {
                key: "showPrompt",
                type: "boolean",
                description: "Include the exact accepted prompt when available",
              },
              "show-error": {
                key: "showError",
                type: "boolean",
                description: "Include the exact execution error when available",
              },
            },
          },
          follow: {
            description:
              "Observe a source-verified remote run; returns local ID, core state and provenance",
            examples: ["bl agent follow RUN_ID --from-workspace OTHER_LAKE"],
            positionals: [{ name: "id", type: "string", required: true }],
            flags: {
              "from-workspace": {
                key: "fromWorkspace",
                type: "string",
                required: true,
                description: "Owning lake of RUN_ID; the shared reference library must be selected",
              },
            },
          },
          activity: {
            description: "Read plugin-observed events, not a full transcript or liveness proof",
            selector: "operation",
            commands: {
              list: {
                description:
                  "Page retained events; returns the stream, events and nextCursor (null when exhausted)",
                examples: [
                  "bl agent activity list RUN_ID",
                  "bl agent activity list HANDLE --after NEXT_CURSOR",
                ],
                positionals: [
                  {
                    name: "target",
                    key: "id",
                    type: "string",
                    description:
                      "Optional run ID, identity or activity handle; omit for all streams",
                  },
                ],
                flags: {
                  after: {
                    type: "number",
                    description: "Exclusive cursor; continue at nextCursor (default 0; minimum 0)",
                  },
                  limit: { type: "number", description: "Page size (default 20; range 1–100)" },
                },
              },
              search: {
                description:
                  "Search retained message/tool excerpts as a phrase; returns stream, events and nextCursor (null when exhausted)",
                examples: [
                  "bl agent activity search 'VPN access'",
                  "bl agent activity search access --target RUN_ID",
                ],
                positionals: [{ name: "query", type: "string", required: true }],
                flags: {
                  target: {
                    key: "id",
                    type: "string",
                    description:
                      "Limit to a run ID, identity or activity handle; omit for all streams",
                  },
                  after: {
                    type: "number",
                    description: "Exclusive cursor; continue at nextCursor (default 0; minimum 0)",
                  },
                  limit: { type: "number", description: "Page size (default 20; range 1–100)" },
                },
              },
              peek: {
                description:
                  "Preview recent events (160-character excerpts), outstanding tools and observed usage. Use activity list HANDLE to page all retained events; not liveness proof",
                examples: ["bl agent activity peek RUN_ID", "bl agent activity peek IDENTITY"],
                positionals: [
                  {
                    name: "target",
                    key: "id",
                    type: "string",
                    required: true,
                    description: "Run ID, identity or activity handle",
                  },
                ],
                flags: {
                  "show-events": {
                    key: "showEvents",
                    type: "boolean",
                    description:
                      "Include full retained event rows with IDs, timestamps and summaries",
                  },
                  "show-stream": {
                    key: "showStream",
                    type: "boolean",
                    description: "Include the native session, capabilities and retention metadata",
                  },
                  limit: {
                    type: "number",
                    description:
                      "Maximum recent events and outstanding tool starts per collection (default 5; 1–100)",
                  },
                },
              },
            },
          },
          cancel: {
            description:
              "Cancel a managed run (pending runs are abandoned); returns { id, state, substatus, settled }",
            examples: ["bl agent cancel RUN_ID"],
            positionals: [{ name: "id", type: "string", required: true }],
          },
          retry: {
            description:
              "Retry a settled managed failure with no served target or request binding; returns { id, state, substatus, settled }",
            examples: ["bl agent retry RUN_ID"],
            positionals: [{ name: "id", type: "string", required: true }],
          },
          acknowledge: {
            description:
              "Acknowledge custody evidence for a settled managed run; returns id and acknowledged",
            examples: ["bl agent acknowledge RUN_ID"],
            positionals: [{ name: "id", type: "string", required: true }],
          },
          resume: {
            description:
              "Create a run from a verified settled session; returns { id, state, substatus, settled }",
            examples: ["bl agent resume RUN_ID 'Continue with the next step'"],
            positionals: [
              { name: "id", type: "string", required: true },
              { name: "prompt", type: "string", required: true },
            ],
            flags: {
              "request-id": {
                key: "requestId",
                type: "string",
                description: "Optional idempotency key for the continuation",
              },
            },
          },
          native: {
            description:
              "Record native session activity; run-id and invocation must be paired. Returns identity, nodeId, instruction, runId, external and systemPrompt",
            examples: [
              'bl agent native --provider pi --native-session-id SESSION_ID --cwd "$PWD" --event agent-end',
              'bl agent native --provider codex --native-session-id SESSION_ID --cwd "$PWD" --run-id RUN_ID --invocation INVOCATION',
            ],
            flags: {
              provider: {
                type: "string",
                required: true,
                description: "Provider namespace (for example: codex, pi, claude)",
              },
              "native-session-id": {
                key: "nativeSessionId",
                type: "string",
                required: true,
                description: "Provider-scoped native session ID",
              },
              cwd: {
                type: "string",
                required: true,
                description: 'Session directory; pass an absolute path such as "$PWD"',
              },
              "run-id": {
                key: "runId",
                type: "string",
                description: "Managed run ID; requires --invocation",
              },
              invocation: { type: "string", description: "Invocation fence; requires --run-id" },
              "parent-native-session-id": {
                key: "parentNativeSessionId",
                type: "string",
                description: "Optional native parent session ID",
              },
              audience: {
                type: "string",
                description:
                  "Recipient: human, agent or unknown; omission uses BL_AUDIENCE (human/agent) or unknown; managed runs use agent",
              },
              event: {
                type: "string",
                description:
                  "Event: session-start, agent-start, agent-end, session-end or metadata (default session-start)",
              },
              "native-event": {
                key: "nativeEvent",
                type: "string",
                description: "Provider-specific event name",
              },
              "session-path": {
                key: "sessionPath",
                type: "string",
                description: "Native transcript path, if known",
              },
              capabilities: {
                type: "string",
                multiple: true,
                description:
                  "activity, tools, messages, usage, model, effort, session-end or parent",
              },
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
              "turn-id": {
                key: "turnId",
                type: "string",
                description: "Provider-reported turn ID",
              },
              activity: {
                type: "json",
                description:
                  "JSON array (max 10); kind: tool-started, tool-ended, message or usage; summaries max 2048 chars",
              },
            },
          },
          start: {
            description:
              "Start a managed run owned by the selected lake, independently of cwd; returns { id, state, substatus, settled }",
            examples: [
              `bl agent start --seat reviewer --cwd "$PWD" --prompt 'Review the change'`,
              "bl --workspace OWNER agent start --seat reviewer --cwd /path/to/OTHER_REPO --target OWNER_TASK --prompt 'Review the other repo; report here'",
              "bl --workspace DEST agent start --seat reviewer --cwd /path/to/DEST --prompt 'Work and record in DEST'",
            ],
            flags: {
              seat: { type: "string", required: true, description: "Available catalog seat" },
              cwd: {
                type: "string",
                required: true,
                description:
                  'Execution directory only; the selected lake keeps custody, activity and BL_WORKSPACE. Pass an absolute path such as "$PWD"',
              },
              prompt: { type: "string", required: true, description: "Instructions for this run" },
              model: {
                type: "string",
                description: "Override seat model for this run; retained on retry and resume",
              },
              effort: {
                type: "string",
                description:
                  "Override seat effort for this run (provider-specific); retained on retry and resume",
              },
              "extra-args": {
                key: "extraArgs",
                type: "json",
                description:
                  "JSON string array replacing seat extraArgs; [] clears; retained on retry and resume",
              },
              target: {
                type: "string",
                description:
                  "Optional owned task or node ID in the selected lake; references cannot be served",
              },
              "request-id": {
                key: "requestId",
                type: "string",
                description: "Optional idempotency key for admission",
              },
              policy: {
                type: "string",
                description:
                  "For a target: stop-on-complete (default; report only) or close-on-complete (agent closes it when satisfied)",
              },
              context: {
                type: "json",
                description: "JSON object of caller-supplied context (default {})",
              },
            },
          },
        },
      },
      async handler(value, _ctx, invocation) {
        const result = await match(value)
          .with({ command: "start" }, async (commandInput) => {
            const { command: _, ...request } = commandInput;
            const run = service.start(request);
            await service.reconcile();

            return runStatus(ctx.graph.show(run.id));
          })
          .with({ command: "list" }, (request) => listRuns(ctx, request))
          .with({ command: "show" }, (request) => showRun(ctx, request))
          .with({ command: "follow" }, async ({ id, fromWorkspace }) => {
            const node = await service.follow(
              { workspace: fromWorkspace, nodeId: id },
              invocation.signal,
            );
            return { id: node.id, title: node.title, state: node.state, reference: node.reference };
          })
          .with({ command: "activity" }, (request) => service.readActivity(request))
          .with({ command: "catalog" }, ({ name, all, showSystemPrompt }) =>
            service.catalog(name, all, showSystemPrompt),
          )
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

function showRun(
  ctx: Context,
  { id, showResult, showError, showPrompt, showSettings, showLaunch }: z.infer<typeof showSchema>,
) {
  const run = ctx.graph.show(id);
  const followed = run.reference !== null;
  if (!followed && run.attributes[agentAttributes.run] !== true)
    throw new Fault("run", "Expected tracked run");
  if (
    run.reference !== null &&
    (showResult || showError || showPrompt || showSettings || showLaunch)
  )
    throw new Fault("reference", "Read run detail from the owning lake", {
      workspace: run.reference.workspace,
      nodeId: run.reference.nodeId,
    });

  const result = run.attributes[agentAttributes.result];
  const error = run.attributes[agentAttributes.error];
  return {
    ...runStatus(run),
    seat: run.attributes[agentAttributes.seat] ?? null,
    provider: run.attributes[agentAttributes.provider] ?? null,
    identity: run.attributes[agentAttributes.identity] ?? null,
    sessionId: run.attributes[agentAttributes.sessionId] ?? null,
    location: run.attributes[agentAttributes.cwd] ?? null,
    attempt: run.attributes[agentAttributes.attempt] ?? null,
    resultAvailable: followed ? null : typeof result === "string",
    errorAvailable: followed ? null : typeof error === "string" && error.length > 0,
    ...(followed ? { title: run.title, observedState: run.state, reference: run.reference } : {}),
    ...(showLaunch ? { launch: run.attributes[agentAttributes.launch] ?? null } : {}),
    ...(showSettings ? { settings: run.attributes[agentAttributes.settings] ?? null } : {}),
    ...(showResult && typeof result === "string" ? { result } : {}),
    ...(showPrompt ? { prompt: run.attributes[agentAttributes.prompt] ?? null } : {}),
    ...(showError && typeof error === "string" && error.length > 0 ? { error } : {}),
  };
}

function runStatus(run: Node) {
  return {
    id: run.id,
    state: run.attributes[agentAttributes.state] ?? null,
    substatus: run.attributes[agentAttributes.substatus] ?? null,
    // External sessions and followed references have no custody settlement observation.
    settled: run.attributes[agentAttributes.settled] ?? null,
  };
}

function listRuns(ctx: Context, { state, limit, offset }: z.infer<typeof listSchema>) {
  const tracked = q.eq(q.attr(agentAttributes.run), true);
  const runs = ctx.graph.all({
    where:
      state === undefined ? tracked : q.and(tracked, q.eq(q.attr(agentAttributes.state), state)),
    includeArchived: true,
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
