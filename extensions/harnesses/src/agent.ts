import { defineOp, type Context } from "@botlake/core";
import { agentMetadata, registrationSchema } from "@botlake/native-session";
import { match } from "ts-pattern";
import { z } from "zod";

import { startSchema, type Harnesses } from "./runs.ts";

const text = z.string().min(1);

export function registerAgent(ctx: Context, service: Harnesses): void {
  const input = z.discriminatedUnion("command", [
    startSchema.extend({ command: z.literal("start") }),
    z.strictObject({ command: z.literal("list") }),
    z.strictObject({ command: z.literal("show"), id: text }),
    z.strictObject({ command: z.literal("catalog"), name: text.optional() }),
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
  ]);

  ctx.register(
    defineOp({
      name: "agent",
      primer:
        "Inspect catalog for seat docs, effective models and availability; catalog NAME shows candidates and full settings. Flags control new seat selection: flag set harness/PROVIDER false disables a provider; alias conditions use generic workspace flags. Start a tracked run with a seat, working directory and prompt. Native plugins report session identity, activity and metadata. Without plugins, managed runs can link output-only session evidence; observation is not liveness. Accepted settings are frozen across flag changes, retry and resume. Inspect show or reconcile before continuing. Process completion does not complete tasks; external sessions carry no stop authority.",
      input,
      output: z.json(),
      cli: {
        description: "Tracked agent runs and native registration",
        examples: [
          "bl agent catalog",
          "bl agent catalog reviewer",
          "bl agent list",
          "bl agent show RUN_ID",
        ],
        commands: {
          list: { description: "Runs" },
          catalog: {
            description: "Seat docs and availability; name expands candidates and settings",
            positionals: [{ name: "name", type: "string" }],
          },
          reconcile: { description: "Reconcile custody" },
          show: {
            description: "Run",
            positionals: [{ name: "id", type: "string", required: true }],
          },
          cancel: {
            description: "Cancel owned process",
            positionals: [{ name: "id", type: "string", required: true }],
          },
          retry: {
            description: "Retry settled failure",
            positionals: [{ name: "id", type: "string", required: true }],
          },
          acknowledge: {
            description: "Release retained process evidence",
            positionals: [{ name: "id", type: "string", required: true }],
          },
          resume: {
            description: "Resume verified session",
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
            description: "Create run",
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

            return ctx.graph.show(run.id);
          })
          .with({ command: "list" }, () => service.runs())
          .with({ command: "show" }, ({ id }) => ctx.graph.show(id))
          .with({ command: "catalog" }, ({ name }) => service.catalog(name))
          .with({ command: "reconcile" }, async () => {
            await service.reconcile();

            return service.runs();
          })
          .with({ command: "cancel" }, ({ id }) => service.cancel(id))
          .with({ command: "retry" }, async ({ id }) => {
            const run = service.retry(id);
            await service.reconcile();

            return run;
          })
          .with({ command: "resume" }, async ({ id, prompt, requestId }) => {
            const run = service.resume(id, prompt, requestId);
            await service.reconcile();

            return run;
          })
          .with({ command: "acknowledge" }, ({ id }) => service.acknowledge(id))
          .with({ command: "native" }, (commandInput) => {
            const { command: _, ...request } = commandInput;

            return service.native({
              ...request,
              ...agentMetadata(request, ctx.env.bl),
            });
          })
          .exhaustive();

        return z.json().parse(result);
      },
    }),
  );
}
