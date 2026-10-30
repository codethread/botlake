import { defineOp, jsonSchema, q, requireValue, type Extension } from "@botlake/core";
import { z } from "zod";

import type { Selection } from "./catalogue.ts";
import { workflowService } from "./engine.ts";
import { workflowFiles } from "./files.ts";

export { workflowRun } from "./engine.ts";
export type { Definition, Metadata } from "./definition.ts";

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
      z.strictObject({ command: z.literal("show"), id: text }),
      z.strictObject({
        command: z.literal("complete"),
        id: text,
        choice: text,
        data: jsonSchema.default({}),
      }),
      z.strictObject({ command: z.literal("claim"), id: text, owner: text.optional() }),
      z.strictObject({
        command: z.literal("block"),
        id: text,
        reason: text,
        neededFrom: text.optional(),
        byIdentity: text.optional(),
      }),
      z.strictObject({
        command: z.literal("unblock"),
        id: text,
        resolution: text,
        byIdentity: text.optional(),
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
    requires: ["identity"],
    activate(ctx) {
      const service = workflowService(ctx, workflowFiles(ctx.workspace));
      ctx.registerQuery("workflow-runs", {
        where: q.eq(q.attr("workflow/root"), true),
        description: "Independent workflow roots",
      });
      ctx.registerQuery("workflow-tasks", {
        where: q.eq(q.attr("workflow/task"), true),
        description: "State-node worker visits",
      });
      ctx.register(
        defineOp({
          name: "workflow",
          input,
          output: jsonSchema,
          jsonSchema: { input, output: jsonSchema },
          about:
            "User-authored XState files: the machine owns flow; the graph owns work, readiness and attribution.",
          primer:
            "Use workflows for reusable processes with choices, parallel work or nested stages; use ordinary graph work for ad hoc tasks. Select an authored definition and inspect its initial input contract in the catalogue before starting. Definitions are workspace files, not built-in templates. Inspect the run for current task summaries, ownership, blockages and previous decisions. Then inspect the selected task for its instructions and outcome schemas before working. Claim authorized ready work, do and verify it, and complete it with the chosen outcome: closure, machine advancement and publication happen together. Groups and the run close automatically; revision creates fresh visits, never reopens completed work. Extra graph children and prerequisites must be settled first. Operational blockages are separate from graph readiness: record the impediment on a task or the whole run and resolve its specific blockage when the reason is addressed. Assignment remains intact. If using Kanban, opt the business card into children progression and link the run as contained work; the card can start immediately but still needs its own completion after all linked work finishes. No agents launch automatically. Help owns command syntax; task detail owns current outcome contracts.",
          cli: {
            description: "Inspect, claim and complete user-authored workflow work",
            examples: [
              "bl workflow catalog",
              "bl workflow start NAME --input '{}'",
              "bl workflow show RUN_ID",
              "bl workflow show TASK_ID",
              "bl workflow claim TASK_ID",
              "bl workflow complete TASK_ID CHOICE --data '{}'",
            ],
            commands: {
              catalog: {
                description:
                  "List authored definitions; NAME or --source reveals initial input schema",
                positionals: [{ name: "name", type: "string" }],
                flags: {
                  source: {
                    type: "string",
                    description:
                      "Use instead of NAME; author module path relative to the workspace, or absolute",
                  },
                },
              },
              start: {
                description:
                  "Start a definition; returns {run,tasks,history}, with the created ID at run.id",
                positionals: [{ name: "name", type: "string" }],
                flags: {
                  source: { type: "string", description: "Use instead of NAME" },
                  input: {
                    type: "json",
                    description: "Initial input; inspect catalog first (default {})",
                  },
                  parent: {
                    type: "string",
                    description: "Optional active work/card containing this run",
                  },
                },
              },
              show: {
                description:
                  "RUN_ID: compact tasks and decision history; TASK_ID: instructions, schemas and original result",
                positionals: [{ name: "id", type: "string", required: true }],
              },
              claim: {
                description: "Claim or hand off a ready task; assignment never launches an agent",
                positionals: [{ name: "id", type: "string", required: true }],
                flags: {
                  owner: { type: "string", description: "Identity (defaults to BL_ACTOR)" },
                },
              },
              complete: {
                description:
                  "Complete TASK_ID with an outcome, advance its actor and publish work atomically",
                positionals: [
                  { name: "id", type: "string", required: true },
                  { name: "choice", type: "string", required: true },
                ],
                flags: {
                  data: {
                    type: "json",
                    description: "Outcome payload (default {}); show TASK_ID reveals its schema",
                  },
                },
              },
              block: {
                description: "Record an operational impediment on RUN_ID or TASK_ID",
                positionals: [{ name: "id", type: "string", required: true }],
                flags: {
                  reason: { type: "string", required: true },
                  "needed-from": {
                    key: "neededFrom",
                    type: "string",
                    description: "Identity whose response can resolve the impediment",
                  },
                  "by-identity": {
                    key: "byIdentity",
                    type: "string",
                    description: "Raised by (defaults to BL_ACTOR)",
                  },
                },
              },
              unblock: {
                description: "Resolve one BLOCK_ID without bypassing other holds or prerequisites",
                positionals: [{ name: "id", type: "string", required: true }],
                flags: {
                  resolution: { type: "string", required: true },
                  "by-identity": {
                    key: "byIdentity",
                    type: "string",
                    description: "Resolved by (defaults to BL_ACTOR)",
                  },
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
                return service.show(value.id);
              case "complete":
                return service.complete(value.id, value.choice, value.data);
              case "claim":
                return service.claim(value.id, value.owner);
              case "block":
                return jsonSchema.parse(
                  service.block(value.id, value.reason, value.neededFrom, value.byIdentity),
                );
              case "unblock":
                return jsonSchema.parse(
                  service.unblock(value.id, value.resolution, value.byIdentity),
                );
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
