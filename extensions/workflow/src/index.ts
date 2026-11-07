import { defineOp, jsonSchema, q, type Extension } from "@botlake/core";
import { gateProbes, workGateChanged } from "@botlake/extension-work";
import { z } from "zod";

import { workflowCatalogue } from "./catalogue.ts";
import type { Definition } from "./definition.ts";
import { workflowService } from "./engine.ts";
import { workflowAttributes } from "./node-model.ts";

export { workflowRun } from "./engine.ts";
export {
  defineWorkflow,
  type Definition,
  type GateEventData,
  type Metadata,
  type ResolvedTask,
} from "./definition.ts";
export {
  workflowAttributes,
  workflowLocatorSchema,
  workflowNamespace,
  workflowRelationNamespace,
  workflowRelations,
  workflowResultSchema,
  workflowSnapshotSchema,
} from "./node-model.ts";

const text = z.string().trim().min(1);
const input = z.compile(
  z.discriminatedUnion("command", [
    z.strictObject({
      command: z.literal("catalog"),
      name: text.optional(),
    }),
    z.strictObject({
      command: z.literal("start"),
      name: text,
      input: jsonSchema.default({}),
      parent: text.optional(),
    }),
    z.strictObject({
      command: z.literal("show"),
      id: text,
      limit: z.number().int().min(1).max(100).default(20),
      offset: z.number().int().nonnegative().default(0),
      historyOffset: z.number().int().nonnegative().default(0),
    }),
    z.strictObject({
      command: z.literal("complete"),
      id: text,
      choice: text,
      data: jsonSchema.default({}),
    }),
  ]),
);

export interface WorkflowOptions {
  /** Trusted definitions selected explicitly for this lake. */
  definitions?: readonly Definition[] | undefined;
}

export function workflows(configuration: WorkflowOptions = {}): Extension {
  const catalogue = workflowCatalogue(configuration.definitions ?? []);
  return {
    name: "workflow",
    source: import.meta.url,
    requires: ["identity", "work"],
    activate(ctx) {
      const service = workflowService(ctx, catalogue);
      gateProbes(ctx).provide(async (key) => catalogue.probe(key));
      ctx.on(workGateChanged, ({ id, to }) => service.reactToGate(id, to));
      ctx.registerQuery("workflow-runs", {
        where: q.eq(q.attr(workflowAttributes.root), true),
        description: "Private workflow execution checkpoints",
      });
      ctx.registerQuery("workflow-tasks", {
        where: q.eq(q.attr(workflowAttributes.task), true),
        description: "Workflow-authored Work tasks",
      });
      ctx.register(
        defineOp({
          name: "workflow",
          input,
          output: jsonSchema,
          jsonSchema: { input, output: jsonSchema },
          about: "Authored XState flow projected into Work groups and tasks.",
          primer:
            "Start an authored definition to create a context Work group and its ready visits. Task gates are ordinary prerequisites and block readiness while open. Gate visits advance once when a mapped status arrives; re-entry reuses an open gate, retries it when exhausted, and creates a new gate only after closure. Gate status explains evaluation but never affects readiness directly. Use work claim for assignment. Generic work close records closure only; workflow complete explicitly submits an outcome and checkpoints a frozen frontier, then publishes the next Work atomically. Pending publication resumes on activation, show or a completion retry. Inspect a task before completion for instructions and outcome schemas.",
          cli: {
            description: "Discover, start, inspect and explicitly advance authored workflows",
            examples: [
              "bl workflow catalog",
              "bl workflow start NAME --input '{}'",
              "bl workflow show RUN_ID",
              "bl workflow complete TASK_ID CHOICE --data '{}'",
            ],
            commands: {
              catalog: {
                description:
                  "List all configured definitions (unpaged), or inspect one definition's input schema and constraints",
                examples: ["bl workflow catalog", "bl workflow catalog NAME"],
                positionals: [
                  {
                    name: "name",
                    type: "string",
                    description: "Configured workflow name; omit when listing",
                  },
                ],
              },
              start: {
                description:
                  "Create a context Work group from a configured workflow; returns first 20 tasks/history entries. Continue with workflow show RUN_ID",
                examples: [
                  'bl workflow start NAME --input \'{"customer":"Acme"}\'',
                  "bl workflow show RUN_ID --offset 20",
                ],
                positionals: [
                  {
                    name: "name",
                    type: "string",
                    required: true,
                    description: "Configured workflow name",
                  },
                ],
                flags: {
                  input: {
                    type: "json",
                    description: "Initial input validated by the definition (default {})",
                  },
                  parent: {
                    type: "string",
                    description:
                      "Optional existing open Work group containing the new context group",
                  },
                },
              },
              show: {
                description:
                  "Show run summaries and paged pending actions/decisions, or a worker task's full instructions and schemas (paging flags apply to runs only)",
                examples: [
                  "bl workflow show RUN_ID",
                  "bl workflow show TASK_ID",
                  "bl workflow show RUN_ID --offset 20",
                  "bl workflow show RUN_ID --history-offset 20",
                ],
                positionals: [
                  {
                    name: "id",
                    type: "string",
                    required: true,
                    description: "Workflow run ID or authored worker task ID",
                  },
                ],
                flags: {
                  limit: {
                    type: "number",
                    description:
                      "Run page size for tasks and history: integer, default 20, min 1, max 100",
                  },
                  offset: {
                    type: "number",
                    description:
                      "Zero-based nonnegative integer (default 0); continue at taskPage.nextOffset, null when exhausted",
                  },
                  "history-offset": {
                    key: "historyOffset",
                    type: "number",
                    description:
                      "Zero-based nonnegative integer (default 0); continue at historyPage.nextOffset, null when exhausted",
                  },
                },
              },
              complete: {
                description:
                  "Submit an authored outcome, checkpoint its frontier and reconcile atomic Work publication; returns updated run view (first 20 tasks/history). Continue with workflow show RUN_ID",
                examples: [
                  "bl workflow complete TASK_ID CHOICE --data '{}'",
                  "bl workflow show RUN_ID --history-offset 20",
                ],
                positionals: [
                  {
                    name: "id",
                    type: "string",
                    required: true,
                    description: "Authored worker task ID, not run ID",
                  },
                  {
                    name: "choice",
                    type: "string",
                    required: true,
                    description: "Choice declared for this task; inspect bl workflow show TASK_ID",
                  },
                ],
                flags: {
                  data: {
                    type: "json",
                    description: "JSON outcome validated by the choice schema (default {})",
                  },
                },
              },
            },
          },
          handler(value, _ctx, invocation) {
            switch (value.command) {
              case "catalog":
                return service.catalog(value.name);
              case "start":
                return service.start(value.name, value.input, value.parent, invocation.identity);
              case "show":
                return service.show(value.id, {
                  limit: value.limit,
                  offset: value.offset,
                  historyOffset: value.historyOffset,
                });
              case "complete":
                return service.complete(value.id, value.choice, value.data, invocation.identity);
            }
          },
        }),
      );
      ctx.resource({
        async start() {
          // Configured probe providers may require Workflow; all must register before recovery.
          for (const run of ctx.graph.all({ where: q.eq(q.attr(workflowAttributes.root), true) }))
            if (run.state === "active") await service.reconcile(run.id);
          for (const node of ctx.graph.all({ where: q.eq(q.attr(workflowAttributes.gate), true) }))
            if (node.attributes[workflowAttributes.consumed] !== true)
              await service.reactToGate(node.id);
        },
        stop() {},
      });
    },
  };
}

export default workflows();
