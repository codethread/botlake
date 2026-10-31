import { defineOp, jsonSchema, q, requireValue, type Extension } from "@botlake/core";
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
    requires: ["identity", "work"],
    activate(ctx) {
      const service = workflowService(ctx, workflowFiles(ctx.workspace));
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
            description: "Start, inspect and advance authored workflow work",
            examples: [
              "bl workflow catalog",
              "bl workflow start NAME --input '{}'",
              "bl workflow show RUN_ID",
              "bl workflow complete TASK_ID CHOICE --data '{}'",
            ],
            commands: {
              catalog: {
                description: "List definitions; NAME or --source reveals the input schema",
                positionals: [{ name: "name", type: "string" }],
                flags: { source: { type: "string", description: "Use instead of NAME" } },
              },
              start: {
                description: "Start a definition and create its context Work group",
                positionals: [{ name: "name", type: "string" }],
                flags: {
                  source: { type: "string", description: "Use instead of NAME" },
                  input: { type: "json", description: "Initial input (default {})" },
                  parent: {
                    type: "string",
                    description: "Optional open Work group containing the context group",
                  },
                },
              },
              show: {
                description: "Run: paged pending actions and decisions; worker: full detail",
                positionals: [{ name: "id", type: "string", required: true }],
                flags: {
                  limit: { type: "number", description: "Page size: default 20, max 100" },
                  offset: {
                    type: "number",
                    description: "Pending actions: continue at taskPage.nextOffset",
                  },
                  "history-offset": {
                    key: "historyOffset",
                    type: "number",
                    description: "Decisions: continue at historyPage.nextOffset",
                  },
                },
              },
              complete: {
                description: "Submit an outcome, checkpoint and publish next work atomically",
                positionals: [
                  { name: "id", type: "string", required: true },
                  { name: "choice", type: "string", required: true },
                ],
                flags: {
                  data: { type: "json", description: "Outcome payload (default {})" },
                },
              },
            },
          },
          handler(value) {
            switch (value.command) {
              case "catalog":
                return service.catalog(selection(value.name, value.source));
              case "start":
                return service.start(
                  requireValue(selection(value.name, value.source), "Select a workflow"),
                  value.input,
                  value.parent,
                );
              case "show":
                return service.show(value.id, {
                  limit: value.limit,
                  offset: value.offset,
                  historyOffset: value.historyOffset,
                });
              case "complete":
                return service.complete(value.id, value.choice, value.data);
            }
          },
        }),
      );
    },
  };
}

function selection(name: string | undefined, source: string | undefined): Selection | undefined {
  if (name !== undefined) return { kind: "named", name };
  if (source !== undefined) return { kind: "file", source };
  return undefined;
}

export default workflows();
