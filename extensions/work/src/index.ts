import { defineOp, jsonSchema, q, type Extension } from "@botlake/core";
import { z } from "zod";

import { registerWorkEvents } from "./events.ts";
import { workAttributes, workRelations } from "./node-model.ts";
import { renderWorkTopology } from "./render.ts";
import { createInput, listInput, updateInput, workStore } from "./store.ts";
import { treeInput } from "./topology.ts";

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
  WorkGraphOptions,
  WorkTreeOptions,
  WorkTopology,
  WorkTopologyNode,
  WorkTopologyOptions,
} from "./types.ts";

const text = z.string().trim().min(1);
const attribution = { by: text.optional() };
const item = { id: text };
const relation = z.enum([workRelations.dependsOn, workRelations.references]);
const topologyInput = treeInput.extend({ format: z.enum(["json", "text"]).optional() });
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
    topologyInput.extend({ command: z.literal("tree") }),
    topologyInput
      .extend({
        command: z.literal("graph"),
        direction: z.enum(["prerequisites", "dependents"]).optional(),
      })
      .refine(
        (value) => value.direction === undefined || value.id !== undefined,
        "Direction requires an id",
      ),
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
            description: "Create, route, inspect and close tasks and context groups",
            examples: [
              'bl work create "Investigate alternatives" --description "Answer with supporting evidence"',
              'bl work create "Delivery context" --kind group',
              "bl work list --view available",
              "bl work list --view human --assignee IDENTITY",
              "bl work show ID --history",
              "bl work tree --lean",
              "bl work graph ID --show-description --show-criteria",
            ],
            commands: {
              create: {
                description:
                  "Create a task by default or a non-assignable context group; returns id, kind and state",
                examples: [
                  'bl work create "Investigate alternatives" --criterion "Compare three options"',
                  'bl work create "Delivery context" --kind group --description "Shared constraints"',
                ],
                positionals: [
                  {
                    name: "title",
                    type: "string",
                    required: true,
                    description: "Short task or group title",
                  },
                ],
                flags: {
                  kind: { type: "string", description: "task (default) or group" },
                  description: { type: "string", description: "Local brief (default empty)" },
                  notes: { type: "string", description: "Initial task findings (default absent)" },
                  parent: {
                    type: "string",
                    description: "Context group; omitted leaves this item at the root",
                  },
                  criterion: {
                    key: "acceptanceCriteria",
                    type: "string",
                    multiple: true,
                    description: "Repeat per task condition; optional",
                  },
                  assignee: {
                    type: "string",
                    description:
                      "Initial responsible identity; omitted leaves it unassigned; HITL work is routed to them",
                  },
                  audience: { type: "string", description: "AFK or HITL; default AFK" },
                  origin: { type: "string", description: "planned or unplanned; default planned" },
                  priority: { type: "string", description: "P0 (highest) through P4; default P2" },
                  prerequisite: {
                    key: "prerequisites",
                    type: "string",
                    multiple: true,
                    description: "Repeat with each direct prerequisite ID",
                  },
                  by: { type: "string", description: "Attribution; defaults to BL_ACTOR" },
                },
              },
              show: {
                description:
                  "Returns item, context, readiness, complete prerequisites/references and paged member summaries; history is opt-in",
                examples: ["bl work show TASK", "bl work show GROUP --limit 50 --history"],
                positionals: [{ name: "id", type: "string", required: true }],
                flags: {
                  history: {
                    type: "boolean",
                    description:
                      "Include assignment, criterion, closure and recovery history (default false)",
                  },
                  limit: {
                    type: "number",
                    description: "Member page size: integer, default 20, min 1, max 100",
                  },
                  offset: {
                    type: "number",
                    description:
                      "Zero-based nonnegative integer (default 0); continue at members.nextOffset, null when exhausted",
                  },
                },
              },
              update: {
                description:
                  "Edit open items or replace notes on closed tasks; criteria use criterion commands. Returns id and revision",
                examples: ['bl work update TASK --notes "Findings and references"'],
                positionals: [{ name: "id", type: "string", required: true }],
                flags: {
                  title: { type: "string", description: "New title" },
                  description: { type: "string", description: "Replace local brief" },
                  notes: { type: "string", description: "Replace task findings" },
                  audience: { type: "string", description: "AFK or HITL" },
                  origin: { type: "string", description: "planned or unplanned" },
                  priority: { type: "string", description: "P0 (highest) through P4" },
                  "expected-revision": {
                    key: "expectedRevision",
                    type: "number",
                    description:
                      "Positive integer concurrency check; omit to update current revision",
                  },
                },
              },
              list: {
                description:
                  "Paged priority-ordered summaries; returns items, total and nextOffset (null when exhausted)",
                examples: [
                  "bl work list --view available",
                  "bl work list --view human --assignee IDENTITY",
                ],
                flags: {
                  view: {
                    type: "string",
                    description: "all (default), ready, available, assigned, waiting or human",
                  },
                  state: {
                    type: "string",
                    description:
                      "open (default), closed or all; search defaults to all in view=all; queue views are open-only",
                  },
                  kind: { type: "string", description: "task or group; no kind filter by default" },
                  assignee: {
                    type: "string",
                    description:
                      "Human view requires --assignee or BL_ACTOR; other views filter current assignment only when supplied",
                  },
                  audience: {
                    type: "string",
                    description: "AFK or HITL; no audience filter by default",
                  },
                  origin: {
                    type: "string",
                    description: "planned or unplanned; no origin filter by default",
                  },
                  parent: {
                    type: "string",
                    description: "Immediate members of this group; no parent filter by default",
                  },
                  search: {
                    type: "string",
                    description:
                      "Case-insensitive title, description and task notes; view=all includes closed work by default",
                  },
                  limit: {
                    type: "number",
                    description: "Page size: integer, default 20, min 1, max 100",
                  },
                  offset: {
                    type: "number",
                    description:
                      "Zero-based nonnegative integer (default 0); continue at nextOffset, null when exhausted; pages are not snapshots",
                  },
                },
              },
              tree: {
                description:
                  "Complete unpaged containment projection (all matching work or descendants of ID; open by default): roots, summary nodes, edges, context, components and omittedLinks",
                examples: ["bl work tree --lean", "bl work tree GROUP --state all -sd -ss"],
                positionals: [
                  { name: "id", type: "string", description: "Optional work-item anchor" },
                ],
                flags: topologyFlags(),
              },
              graph: {
                description:
                  "Complete unpaged dependency projection for all matching work or transitive links from ID; open by default; returns summary nodes, edges, components and omittedLinks",
                examples: ["bl work graph TASK", "bl work graph TASK --direction dependents"],
                positionals: [
                  { name: "id", type: "string", description: "Optional dependency root" },
                ],
                flags: {
                  ...topologyFlags(),
                  direction: {
                    type: "string",
                    description: "prerequisites (default) or dependents; requires ID",
                  },
                },
              },
              close: {
                description:
                  "Close after criteria resolve or contained tasks close; releases assignment and returns closure attribution, not success or workflow completion",
                examples: ["bl work close TASK"],
                positionals: [{ name: "id", type: "string", required: true }],
                flags: { by: { type: "string", description: "Attribution; defaults to BL_ACTOR" } },
              },
              reopen: {
                description:
                  "Reopen for recovery, retaining criterion resolutions and closure history; returns id and open state",
                examples: ['bl work reopen TASK --reason "Recheck the result"'],
                positionals: [{ name: "id", type: "string", required: true }],
                flags: {
                  reason: {
                    type: "string",
                    required: true,
                    description: "Required recovery reason",
                  },
                  by: { type: "string", description: "Attribution; defaults to BL_ACTOR" },
                },
              },
              claim: {
                description:
                  "Reserve ready work; competing owners must release first. Returns id and assignment; use assignment.id as --assignment-id to release",
                examples: ["bl work claim TASK", "bl work claim TASK --assignee IDENTITY"],
                positionals: [{ name: "id", type: "string", required: true }],
                flags: {
                  assignee: {
                    type: "string",
                    description: "Responsible identity; defaults to BL_ACTOR",
                  },
                  by: { type: "string", description: "Attribution; defaults to BL_ACTOR" },
                },
              },
              release: {
                description:
                  "Release only the matching assignment, preserving work/history; returns released true or false",
                examples: ['bl work release TASK --assignment-id TOKEN --reason "Handing off"'],
                positionals: [{ name: "id", type: "string", required: true }],
                flags: {
                  "assignment-id": {
                    key: "assignmentId",
                    type: "string",
                    required: true,
                    description: "Current assignment fencing token",
                  },
                  reason: {
                    type: "string",
                    required: true,
                    description: "Required release reason",
                  },
                  by: { type: "string", description: "Attribution; defaults to BL_ACTOR" },
                },
              },
              move: {
                description:
                  "Set one context parent or detach; supply exactly one of --parent and --root",
                examples: ["bl work move TASK --parent GROUP", "bl work move TASK --root"],
                positionals: [{ name: "id", type: "string", required: true }],
                flags: {
                  parent: { type: "string", description: "New context group" },
                  root: {
                    type: "boolean",
                    description: "Detach from contextual containment (default false)",
                  },
                },
              },
              link: {
                description:
                  "Add a direct prerequisite (from depends on to) or a non-contextual reference",
                examples: ["bl work link TASK BLOCKER --relation depends-on"],
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
                description: "Remove the specified prerequisite or reference",
                examples: ["bl work unlink TASK BLOCKER --relation depends-on"],
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
              criterion: {
                description: "Manage immutable task conditions and append-only assessments",
                selector: "operation",
                commands: {
                  add: {
                    description:
                      "Append an immutable condition to an open task; returns its criterion ID",
                    examples: ['bl work criterion add TASK "Tests pass"'],
                    positionals: [
                      { name: "id", type: "string", required: true },
                      { name: "condition", type: "string", required: true },
                    ],
                    flags: {
                      by: { type: "string", description: "Attribution; defaults to BL_ACTOR" },
                    },
                  },
                  resolve: criterionCommand(
                    "Record an assessment, including unmet or no longer required; output retains the condition",
                    'bl work criterion resolve TASK CRITERION "Satisfied by test report"',
                  ),
                  correct: criterionCommand(
                    "Append a corrected assessment without erasing prior history",
                    'bl work criterion correct TASK CRITERION "Correction: report covers all cases"',
                  ),
                  reopen: criterionCommand(
                    "Restore a resolved condition on an open task; TEXT is the required reason",
                    'bl work criterion reopen TASK CRITERION "Evidence needs rechecking"',
                  ),
                },
              },
            },
          },
          handler(value, _ctx, invocation) {
            switch (value.command) {
              case "tree":
              case "graph": {
                const { command, format, ...options } = value;
                const result = command === "tree" ? store.tree(options) : store.graph(options);
                const selectedFormat =
                  invocation.output.format === "json"
                    ? "json"
                    : (format ?? (invocation.terminal.isTTY ? "text" : "json"));
                return selectedFormat === "text"
                  ? invocation.output.text(renderWorkTopology(result, invocation.terminal.columns))
                  : jsonSchema.parse(result);
              }
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

function topologyFlags() {
  return {
    format: {
      type: "string" as const,
      description:
        "json or text; default text on a terminal, JSON otherwise; global --json forces JSON",
    },
    state: {
      type: "string" as const,
      description:
        "open (default), closed or all; omittedLinks counts scoped links crossing this filter",
    },
    lean: {
      type: "boolean" as const,
      description:
        "Only id, title and state per node (default false); overrides detail flags, preserves edges",
    },
    "show-description": {
      short: "sd",
      key: "showDescription",
      type: "boolean" as const,
      description: "Include each node's local description (default false)",
    },
    "show-criteria": {
      short: "ss",
      key: "showCriteria",
      type: "boolean" as const,
      description: "Include task conditions and current assessments (default false; not history)",
    },
  };
}

function criterionCommand(description: string, example: string) {
  return {
    description,
    examples: [example],
    positionals: [
      { name: "id", type: "string" as const, required: true },
      { name: "criterion", type: "string" as const, required: true },
      { name: "text", type: "string" as const, required: true },
    ],
    flags: {
      by: { type: "string" as const, description: "Attribution; defaults to BL_ACTOR" },
    },
  };
}
