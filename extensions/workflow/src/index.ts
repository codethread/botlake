import { defineOp, Fault, jsonSchema, q, requireValue, type Extension } from "@botlake/core";
import { workGateChanged } from "@botlake/extension-work";
import { gateProbes } from "@botlake/extension-work-gates";
import { z } from "zod";

import type { Selection } from "./catalogue.ts";
import { workflowService } from "./engine.ts";
import { workflowFiles } from "./files.ts";
import { workflowAttributes } from "./node-model.ts";

export { workflowRun } from "./engine.ts";
export type { Definition, Metadata } from "./definition.ts";
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
  z
    .discriminatedUnion("command", [
      z.strictObject({
        command: z.literal("catalog"),
        name: text.optional(),
        source: text.optional(),
      }),
      z.strictObject({
        command: z.literal("start"),
        name: text.optional(),
        source: text.optional(),
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
    ])
    .superRefine((value, ctx) => {
      if (value.command !== "catalog" && value.command !== "start") return;
      if (value.name !== undefined && value.source !== undefined)
        ctx.addIssue({ code: "custom", message: "Choose a workflow name or --source, not both" });
      if (value.command === "start" && value.name === undefined && value.source === undefined)
        ctx.addIssue({
          code: "custom",
          message: "Choose a workflow name or --source; inspect bl workflow catalog",
        });
    }),
);

export function workflows(): Extension {
  return {
    name: "workflow",
    source: import.meta.url,
    requires: ["identity", "work"],
    async activate(ctx) {
      const catalogue = workflowFiles(ctx.workspace);
      const service = workflowService(ctx, catalogue);
      let gatesSelected = false;
      try {
        gateProbes(ctx).provide(async (key) => {
          const separator = key.indexOf("/");
          if (separator <= 0 || separator === key.length - 1) return;
          const name = key.slice(0, separator);
          const probeName = key.slice(separator + 1);
          const loaded = await catalogue.load({ kind: "named", name });
          return loaded.definition.probes.find((probe) => probe.name === probeName);
        });
        ctx.on(workGateChanged, ({ id, to }) => service.reactToGate(id, to));
        gatesSelected = true;
      } catch (error) {
        if (!(error instanceof Fault) || error.code !== "work-gates") throw error;
      }
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
            "Start an authored definition to create a context Work group and its ready tasks. Use work claim for assignment. Generic work close records closure only; workflow complete explicitly submits an outcome, checkpoints the actor and publishes the next Work atomically. Inspect a task before completion for instructions and outcome schemas.",
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
                  "List all local definitions (unpaged), or inspect one definition's input schema and constraints",
                examples: [
                  "bl workflow catalog",
                  "bl workflow catalog NAME",
                  "bl workflow catalog --source .workflows/demo/workflow.ts",
                ],
                positionals: [
                  {
                    name: "name",
                    type: "string",
                    description: "Named workflow; omit when listing",
                  },
                ],
                flags: {
                  source: {
                    type: "string",
                    description:
                      "Workflow entry file instead of NAME; mutually exclusive with NAME",
                  },
                },
              },
              start: {
                description:
                  "Create a context Work group from a named or file workflow; returns first 20 tasks/history entries. Continue with workflow show RUN_ID",
                examples: [
                  'bl workflow start NAME --input \'{"customer":"Acme"}\'',
                  "bl workflow start --source .workflows/demo/workflow.ts",
                  "bl workflow show RUN_ID --offset 20",
                ],
                positionals: [
                  {
                    name: "name",
                    type: "string",
                    description: "Named workflow; required unless --source is supplied",
                  },
                ],
                flags: {
                  source: {
                    type: "string",
                    description:
                      "Workflow entry file instead of NAME; mutually exclusive with NAME",
                  },
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
                  "Submit an authored outcome, checkpoint and publish subsequent Work atomically; returns updated run view (first 20 tasks/history). Continue with workflow show RUN_ID",
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
                return service.catalog(selection(value.name, value.source));
              case "start":
                return service.start(
                  requireValue(selection(value.name, value.source), "Select a workflow"),
                  value.input,
                  value.parent,
                  invocation.identity,
                );
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
      if (gatesSelected)
        for (const node of ctx.graph.all({ where: q.eq(q.attr(workflowAttributes.gate), true) }))
          if (node.attributes[workflowAttributes.consumed] !== true)
            await service.reactToGate(node.id);
    },
  };
}

function selection(name: string | undefined, source: string | undefined): Selection | undefined {
  if (name !== undefined) return { kind: "named", name };
  if (source !== undefined) return { kind: "file", source };
  return undefined;
}

export default workflows();
