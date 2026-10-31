import { defineOp, jsonSchema, q, type Extension } from "@botlake/core";
import { z } from "zod";

import { registerWorkEvents } from "./events.ts";
import { workAttributes, workRelations } from "./node-model.ts";
import { createInput, listInput, updateInput, workStore } from "./store.ts";

export { workAssignmentEstablished, workChanged } from "./events.ts";
export {
  assignmentSchema,
  storedCriterionSchema,
  workAttributes,
  workDataSchema,
  workRelations,
} from "./node-model.ts";
export type { StoredCriterion, WorkData, WorkLinkRelation } from "./node-model.ts";
export { workStore } from "./store.ts";
export type {
  Assignment,
  Attribution,
  CreateItem,
  Criterion,
  CriterionChange,
  Group,
  ListOptions,
  Page,
  Task,
  UpdateItem,
  WorkDetail,
  WorkItem,
  WorkStore,
  WorkSummary,
} from "./types.ts";

const text = z.string().trim().min(1);
const attribution = { by: text.optional() };
const item = { id: text };
const relation = z.enum([workRelations.dependsOn, workRelations.references]);
const input = z.compile(
  z.discriminatedUnion("command", [
    z.discriminatedUnion("kind", [
      createInput.options[0].extend({
        command: z.literal("create"),
        kind: z.literal("task").default("task"),
      }),
      createInput.options[1].extend({ command: z.literal("create") }),
    ]),
    updateInput.extend({ command: z.literal("update"), ...item }),
    listInput.extend({ command: z.literal("list") }),
    z.strictObject({
      command: z.literal("show"),
      ...item,
      history: z.boolean().default(false),
      limit: z.number().int().min(1).max(100).default(20),
      offset: z.number().int().nonnegative().default(0),
    }),
    z.strictObject({ command: z.literal("close"), ...item, ...attribution }),
    z.strictObject({ command: z.literal("reopen"), ...item, reason: text, ...attribution }),
    z.strictObject({
      command: z.literal("claim"),
      ...item,
      assignee: text.optional(),
      ...attribution,
    }),
    z.strictObject({
      command: z.literal("release"),
      ...item,
      assignmentId: text,
      reason: text,
      ...attribution,
    }),
    z
      .strictObject({
        command: z.literal("move"),
        ...item,
        parent: text.optional(),
        root: z.boolean().default(false),
      })
      .refine(
        (value) => value.root !== (value.parent !== undefined),
        "Supply either --parent GROUP or --root",
      ),
    z.strictObject({ command: z.literal("link"), from: text, to: text, relation }),
    z.strictObject({ command: z.literal("unlink"), from: text, to: text, relation }),
    z.discriminatedUnion("operation", [
      z.strictObject({
        command: z.literal("criterion"),
        operation: z.literal("add"),
        ...item,
        condition: text,
        ...attribution,
      }),
      z.strictObject({
        command: z.literal("criterion"),
        operation: z.enum(["resolve", "correct", "reopen"]),
        ...item,
        criterion: text,
        text,
        ...attribution,
      }),
    ]),
  ]),
);

export function work(): Extension {
  return {
    name: "work",
    requires: ["identity"],
    activate(ctx) {
      registerWorkEvents(ctx);
      const store = workStore(ctx);
      ctx.registerQuery("work-items", {
        where: q.eq(q.attr(workAttributes.item), true),
        description: "Tasks and context groups",
      });
      ctx.register(
        defineOp({
          name: "work",
          input,
          output: jsonSchema,
          jsonSchema: { input, output: jsonSchema },
          about:
            "Tasks express work; groups supply shared context. Dependencies determine readiness, references retain connections. Description is the brief; notes hold conclusions; optional criteria constrain closure.",
          primer:
            "List --view available for ready unassigned AFK tasks, or --view human --assignee IDENTITY for ready HITL work. Show reveals the local brief, ancestor context, criteria, notes and relationships. Claim reserves responsibility, not proof of execution; defaults to BL_ACTOR. Every added criterion needs an explicit resolution before close, including unmet or retired conditions. Groups close only after all contained tasks close; only groups can be parents. Dependencies can target tasks or groups and do not assert success. Closure never advances a workflow; submit its authored action explicitly. New scope is new work. Reopen only for recovery; prior resolutions stay intact until explicitly corrected/reopened. Release requires the current assignment token so stale observations cannot clear a newer owner. List defaults to open work; search includes closed work. Pages are not snapshots.",
          cli: {
            description: "Tasks, context groups, prerequisites and composed work views",
            examples: [
              'bl work create "Investigate alternatives" --description "Answer with supporting evidence"',
              'bl work create "Delivery context" --kind group',
              "bl work list --view available",
              "bl work list --view human --assignee IDENTITY",
              "bl work show ID --history",
            ],
            commands: {
              create: {
                description: "Create a task (default) or a non-assignable context group",
                positionals: [{ name: "title", type: "string", required: true }],
                flags: {
                  kind: { type: "string", description: "task (default) or group" },
                  description: { type: "string" },
                  notes: { type: "string" },
                  parent: { type: "string", description: "Context group" },
                  criterion: {
                    key: "acceptanceCriteria",
                    type: "string",
                    multiple: true,
                    description: "Repeat for each condition; optional",
                  },
                  assignee: {
                    type: "string",
                    description: "Responsible identity; HITL routes to this person",
                  },
                  audience: { type: "string", description: "AFK (default) or HITL" },
                  origin: { type: "string", description: "planned (default) or unplanned" },
                  priority: {
                    type: "string",
                    description: "P0 immediate through P4 lowest; default P2",
                  },
                  prerequisite: { key: "prerequisites", type: "string", multiple: true },
                  by: { type: "string", description: "Attribution (defaults to BL_ACTOR)" },
                },
              },
              show: {
                description:
                  "Brief, criteria, findings, context and relationships; members are paged",
                positionals: [{ name: "id", type: "string", required: true }],
                flags: {
                  history: {
                    type: "boolean",
                    description: "Include full criterion, assignment and recovery history",
                  },
                  limit: { type: "number" },
                  offset: { type: "number", description: "Continue members at nextOffset" },
                },
              },
              update: {
                description: "Edit the brief or findings; criteria use explicit operations",
                positionals: [{ name: "id", type: "string", required: true }],
                flags: {
                  title: { type: "string" },
                  description: { type: "string" },
                  notes: { type: "string" },
                  audience: { type: "string" },
                  origin: { type: "string" },
                  priority: { type: "string" },
                  "expected-revision": { key: "expectedRevision", type: "number" },
                },
              },
              list: {
                description: "Paged summaries ordered by priority; search includes closed work",
                flags: {
                  view: {
                    type: "string",
                    description: "all (default), ready, available, assigned, waiting or human",
                  },
                  state: {
                    type: "string",
                    description: "open (default), closed or all; search defaults to all",
                  },
                  kind: { type: "string" },
                  assignee: {
                    type: "string",
                    description:
                      "Human view defaults to BL_ACTOR; otherwise an explicit assignment filter",
                  },
                  audience: { type: "string" },
                  origin: { type: "string" },
                  parent: { type: "string", description: "Immediate members of this group" },
                  search: {
                    type: "string",
                    description: "Case-insensitive title, description and notes search",
                  },
                  limit: { type: "number", description: "Page size: default 20, max 100" },
                  offset: {
                    type: "number",
                    description: "Continue at nextOffset; pages are not snapshots",
                  },
                },
              },
              close: {
                description:
                  "Close resolved work; does not assert success or submit a workflow action",
                positionals: [{ name: "id", type: "string", required: true }],
                flags: { by: { type: "string" } },
              },
              reopen: {
                description:
                  "Recovery only; retains prior criteria resolutions and closure history",
                positionals: [{ name: "id", type: "string", required: true }],
                flags: { reason: { type: "string", required: true }, by: { type: "string" } },
              },
              claim: {
                description: "Reserve ready work; a competing owner must explicitly release first",
                positionals: [{ name: "id", type: "string", required: true }],
                flags: {
                  assignee: { type: "string", description: "Defaults to BL_ACTOR" },
                  by: { type: "string" },
                },
              },
              release: {
                description:
                  "Release only the matching current assignment; preserves work and history",
                positionals: [{ name: "id", type: "string", required: true }],
                flags: {
                  "assignment-id": { key: "assignmentId", type: "string", required: true },
                  reason: { type: "string", required: true },
                  by: { type: "string" },
                },
              },
              move: {
                description: "Move into one context group, or detach with --root",
                positionals: [{ name: "id", type: "string", required: true }],
                flags: {
                  parent: { type: "string", description: "New context group" },
                  root: { type: "boolean", description: "Detach from contextual containment" },
                },
              },
              link: {
                description: "Add a prerequisite or non-contextual reference",
                positionals: [
                  { name: "from", type: "string", required: true },
                  { name: "to", type: "string", required: true },
                ],
                flags: {
                  relation: {
                    type: "string",
                    required: true,
                    description: "depends-on or references",
                  },
                },
              },
              unlink: {
                description: "Remove a prerequisite or reference",
                positionals: [
                  { name: "from", type: "string", required: true },
                  { name: "to", type: "string", required: true },
                ],
                flags: { relation: { type: "string", required: true } },
              },
              criterion: {
                description: "Preserve conditions; resolve or explicitly correct their assessments",
                selector: "operation",
                commands: {
                  add: {
                    description: "Append an immutable condition to an open task",
                    positionals: [
                      { name: "id", type: "string", required: true },
                      { name: "condition", type: "string", required: true },
                    ],
                    flags: { by: { type: "string" } },
                  },
                  resolve: criterionCommand(
                    "Record an assessment, including unmet or no longer required",
                  ),
                  correct: criterionCommand(
                    "Append a corrected assessment without erasing the original",
                  ),
                  reopen: criterionCommand("Restore an open condition with an explicit reason"),
                },
              },
            },
          },
          handler(value) {
            switch (value.command) {
              case "create": {
                const { command: _, ...request } = value;
                const result = store.create(request);
                return { id: result.id, kind: result.kind, state: result.state };
              }
              case "update": {
                const { command: _, id, ...request } = value;
                const result = store.update(id, request);
                return { id, revision: result.revision };
              }
              case "show":
                return jsonSchema.parse(
                  store.inspect(value.id, {
                    history: value.history,
                    limit: value.limit,
                    offset: value.offset,
                  }),
                );
              case "list": {
                const { command: _, ...request } = value;
                return jsonSchema.parse(store.list(request));
              }
              case "close": {
                const result = store.close(value.id, value.by);
                return {
                  id: result.id,
                  state: result.state,
                  closedBy: result.closedBy,
                  closedAt: result.closedAt,
                };
              }
              case "reopen": {
                const result = store.reopen(value.id, value.reason, value.by);
                return { id: result.id, state: result.state };
              }
              case "claim":
                return jsonSchema.parse({
                  id: value.id,
                  assignment: store.claim(value.id, value.assignee, value.by),
                });
              case "release":
                return {
                  id: value.id,
                  released: store.release(value.id, value.assignmentId, value.reason, value.by),
                };
              case "move": {
                const parent = value.parent ?? null;
                store.move(value.id, parent);
                return { id: value.id, parent };
              }
              case "link":
                store.link(value.from, value.to, value.relation);
                return { from: value.from, to: value.to, relation: value.relation, linked: true };
              case "unlink":
                store.unlink(value.from, value.to, value.relation);
                return { from: value.from, to: value.to, relation: value.relation, linked: false };
              case "criterion": {
                if (value.operation === "add")
                  return jsonSchema.parse(store.addCriterion(value.id, value.condition, value.by));
                if (value.operation === "reopen")
                  return jsonSchema.parse(
                    store.reopenCriterion(value.id, value.criterion, value.text, value.by),
                  );
                return jsonSchema.parse(
                  store.resolveCriterion(
                    value.id,
                    value.criterion,
                    value.text,
                    value.by,
                    value.operation === "correct",
                  ),
                );
              }
            }
          },
        }),
      );
    },
  };
}

export default work();

// -- CLI fragments --

function criterionCommand(description: string) {
  return {
    description,
    positionals: [
      { name: "id", type: "string" as const, required: true },
      { name: "criterion", type: "string" as const, required: true },
      { name: "text", type: "string" as const, required: true },
    ],
    flags: { by: { type: "string" as const } },
  };
}
