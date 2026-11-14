import {
  canonical,
  dependencyAttributes,
  Fault,
  jsonSchema,
  q,
  requireValue,
  type Attributes,
  type Context,
  type Graph,
  type Mutation,
  type Node,
  type Predicate,
} from "@botlake/core";
import { z } from "zod";

import { workAssignmentEstablished, workGateChanged } from "./events.ts";
import { transitionGate } from "./gates.ts";
import {
  taskDataSchema,
  text,
  workAttributes,
  workDataSchema,
  workNamespace,
  workRelations,
  gatePolicySchema,
  jsonObjectSchema,
  type StoredCriterion,
  type TaskData,
  type WorkData,
  type WorkLinkRelation,
} from "./node-model.ts";
import {
  graphInput,
  projectGraph,
  projectTree,
  treeInput,
  type TopologySource,
} from "./topology.ts";
import type {
  Assignment,
  CreateItem,
  Criterion,
  Gate,
  GateCommand,
  GatePolicy,
  JsonObject,
  GateTransition,
  Group,
  ListOptions,
  Page,
  UpdateItem,
  WorkDetail,
  WorkGraphOptions,
  WorkItem,
  WorkStore,
  WorkSummary,
  WorkTopology,
  WorkTopologyOptions,
  WorkTreeOptions,
} from "./types.ts";

const authority = Symbol("work");
const stores = new WeakMap<Graph, WorkStore>();
const gateLifecycles = new WeakMap<Context, (id: string) => void>();
const workRelationLabels: readonly string[] = Object.values(workRelations);
const requiredReferenceKinds = ["work/task", "work/group", "work/gate"] as const;
const requiredReferenceKindsSchema = z.tuple([
  z.literal("work/task"),
  z.literal("work/group"),
  z.literal("work/gate"),
]);
const createCommon = {
  title: text,
  description: z.string().default(""),
  parent: text.optional(),
  prerequisites: z.array(text).default([]),
  by: text.optional(),
};
export const createInput = z.compile(
  z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("task"),
      ...createCommon,
      notes: z.string().optional(),
      acceptanceCriteria: z.array(text).default([]),
      assignee: text.optional(),
      audience: taskDataSchema.shape.audience.default("AFK"),
      origin: taskDataSchema.shape.origin.default("planned"),
      priority: taskDataSchema.shape.priority.default("P2"),
    }),
    z.strictObject({ kind: z.literal("group"), ...createCommon }),
  ]),
);
const gateCommandSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("attempt"),
    round: z.number().int().positive(),
    attempt: z.number().int().positive(),
    at: z.iso.datetime(),
    by: text,
    result: z.discriminatedUnion("outcome", [
      z.object({
        outcome: z.literal("passed"),
        message: text,
        evidence: jsonObjectSchema.optional(),
      }),
      z.object({
        outcome: z.enum(["failed", "errored"]),
        at: z.iso.datetime(),
        message: text,
        evidence: jsonObjectSchema.optional(),
      }),
    ]),
  }),
  z.object({ type: z.literal("retry"), at: z.iso.datetime(), by: text, reason: text }),
  z.object({ type: z.literal("clear"), at: z.iso.datetime(), by: text, message: text }),
  z.object({ type: z.literal("dismiss"), at: z.iso.datetime(), by: text, reason: text }),
]);
export const updateInput = z.compile(
  z.strictObject({
    title: text.optional(),
    description: z.string().optional(),
    notes: z.string().optional(),
    audience: taskDataSchema.shape.audience.optional(),
    origin: taskDataSchema.shape.origin.optional(),
    priority: taskDataSchema.shape.priority.optional(),
    expectedRevision: z.number().int().positive().optional(),
  }),
);
const pagination = {
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().nonnegative().default(0),
};
export const listInput = z.compile(
  z.strictObject({
    view: z.enum(["all", "ready", "available", "assigned", "waiting", "human"]).default("all"),
    state: z.enum(["open", "closed", "all"]).optional(),
    kind: z.enum(["task", "group", "gate"]).optional(),
    assignee: text.optional(),
    origin: taskDataSchema.shape.origin.optional(),
    audience: taskDataSchema.shape.audience.optional(),
    search: text.optional(),
    parent: text.optional(),
    ...pagination,
  }),
);
const inspectInput = z.compile(
  z.strictObject({ history: z.boolean().default(false), ...pagination }),
);

/** Work-internal synchronous revocation after commit, before queued notifications. */
export function registerGateLifecycle(ctx: Context, changed: (id: string) => void): void {
  gateLifecycles.set(ctx, changed);
}

/** Shared work operations; sibling extensions use this same model and assignment ledger. */
export function workStore(ctx: Context): WorkStore {
  const cached = stores.get(ctx.graph);
  if (cached !== undefined) return cached;
  const graph = ctx.graph;
  graph.protect((changes, token) => {
    protect(graph, changes, token);
  });

  function create(raw: CreateItem): WorkItem {
    const input = createInput.parse(raw);
    return graph.atomic(() => {
      const base = {
        description: input.description,
        closures: [],
        reopenings: [],
        abandonments: [],
      };
      const data: WorkData =
        input.kind === "group"
          ? { kind: "group", ...base }
          : {
              kind: "task",
              ...base,
              notes: input.notes ?? null,
              audience: input.audience,
              origin: input.origin,
              priority: input.priority,
              criteria: input.acceptanceCriteria.map((condition) => ({
                id: crypto.randomUUID(),
                condition,
                ...attribution(input.by),
                changes: [],
              })),
              assignments:
                input.assignee === undefined ? [] : [newAssignment(input.assignee, input.by)],
            };
      const node = graph.add({
        title: input.title,
        attributes: { [workAttributes.item]: true, ...attributesFor(data) },
      });
      if (input.parent !== undefined) move(node.id, input.parent);
      for (const prerequisite of input.prerequisites)
        link(node.id, prerequisite, workRelations.dependsOn);
      const item = get(node.id);
      if (item.kind === "task" && item.assignment !== null)
        ctx.emit(workAssignmentEstablished, { task: item.id, assignment: item.assignment });
      return item;
    }, authority);
  }

  function get(id: string): WorkItem {
    const node = graph.show(id);
    const data = read(node);
    const closed = node.state === "closed" ? data.closures.at(-1) : undefined;
    const base = {
      id: node.id,
      title: node.title,
      description: data.description,
      state: node.state === "closed" ? ("closed" as const) : ("open" as const),
      revision: node.revision,
      closedBy: closed?.by ?? null,
      closedAt: closed?.at ?? null,
    };
    if (data.kind === "group") return { ...base, kind: "group" };
    if (data.kind === "gate")
      return {
        ...base,
        kind: "gate",
        probe: data.probe,
        params: data.params,
        policy: data.policy,
        status: data.status,
      };
    const assignment = currentAssignment(data);
    return {
      ...base,
      kind: "task",
      notes: data.notes,
      acceptanceCriteria: data.criteria.map(criterionView),
      assignee: assignment?.assignee ?? null,
      assignment,
      audience: data.audience,
      origin: data.origin,
      priority: data.priority,
    };
  }

  function update(id: string, raw: UpdateItem): WorkItem {
    const input = updateInput.parse(raw);
    return graph.atomic(() => {
      const item = get(id);
      const data = read(graph.show(id));
      if (item.kind === "gate")
        throw new Fault("work-gate", "Gates are changed only through the gate API");
      if (Object.keys(input).every((key) => key === "expectedRevision"))
        throw new Fault("work", "Supply a field to update");
      if (
        item.state === "closed" &&
        Object.keys(input).some((key) => key !== "notes" && key !== "expectedRevision")
      )
        throw new Fault("work", "Preserve completed scope; reopen for recovery or create new work");
      if (
        data.kind !== "task" &&
        [input.notes, input.audience, input.origin, input.priority].some(
          (value) => value !== undefined,
        )
      )
        throw new Fault("work", "Only tasks have task fields");
      if (input.description !== undefined) data.description = input.description;
      if (data.kind === "task") {
        if (input.notes !== undefined) data.notes = input.notes;
        if (input.audience !== undefined) data.audience = input.audience;
        if (input.origin !== undefined) data.origin = input.origin;
        if (input.priority !== undefined) data.priority = input.priority;
      }
      graph.update(id, {
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.expectedRevision === undefined
          ? {}
          : { expectedRevision: input.expectedRevision }),
        attributes: attributesFor(data),
      });
      return get(id);
    }, authority);
  }

  function inspect(
    id: string,
    options: { history?: boolean; limit?: number; offset?: number } = {},
  ): WorkDetail {
    const input = inspectInput.parse(options);
    const item = get(id);
    const data = read(graph.show(id));
    const context: Group[] = [];
    let ancestor = parentOf(id);
    while (ancestor !== null) {
      const group = get(ancestor);
      if (group.kind !== "group") throw new Fault("work", "Invalid contextual parent");
      context.unshift(group);
      ancestor = parentOf(group.id);
    }
    return {
      item,
      context,
      ready: ready(id),
      prerequisites: outgoing(id, workRelations.dependsOn).map((target) => summary(target)),
      references: outgoing(id, workRelations.references).map((target) => summary(target)),
      members: page(
        outgoing(id, workRelations.parentOf).map((target) => summary(target)),
        input.limit,
        input.offset,
      ),
      ...(input.history
        ? {
            history: {
              assignments: data.kind === "task" ? data.assignments : [],
              criteria:
                data.kind === "task"
                  ? data.criteria.map(({ id: criterionId, changes }) => ({
                      id: criterionId,
                      changes,
                    }))
                  : [],
              closures: data.closures,
              reopenings: data.reopenings,
              abandonments: data.abandonments,
            },
          }
        : {}),
    };
  }

  function summary(id: string): WorkSummary {
    const node = graph.show(id);
    if (node.reference !== null)
      return {
        id: node.id,
        kind: "reference",
        title: node.title,
        state: node.state === "closed" ? "closed" : "open",
        ready: false,
        assignee: null,
        audience: null,
        origin: null,
        priority: null,
        parent: null,
        reference: node.reference,
      };
    const item = get(id);
    return {
      id: item.id,
      kind: item.kind,
      title: item.title,
      state: item.state,
      ready: ready(id),
      assignee: item.kind === "task" ? item.assignee : null,
      audience: item.kind === "task" ? item.audience : null,
      origin: item.kind === "task" ? item.origin : null,
      priority: item.kind === "task" ? item.priority : null,
      parent: parentOf(id),
      gate: item.kind === "gate" ? { probe: item.probe, status: item.status } : null,
    };
  }

  function list(raw: ListOptions = {}): Page<WorkSummary> {
    const input = listInput.parse(raw);
    const state = input.state ?? (input.search === undefined ? "open" : "all");
    const human =
      input.view === "human"
        ? requireValue(input.assignee, "Supply --assignee or caller identity for the human queue")
        : undefined;
    const needle = input.search?.toLowerCase();
    const where: [Predicate, ...Predicate[]] = [q.eq(q.attr(workAttributes.item), true)];
    if (state !== "all") where.push(q.eq("state", state === "open" ? "active" : "closed"));
    if (input.kind !== undefined) where.push(q.eq(q.attr(workAttributes.kind), input.kind));
    if (input.origin !== undefined) where.push(q.eq(q.attr(workAttributes.origin), input.origin));
    if (input.audience !== undefined)
      where.push(q.eq(q.attr(workAttributes.audience), input.audience));
    const matches = graph
      .all({ where: q.and(...where), includeArchived: true })
      .filter((node) => {
        const item = get(node.id);
        if (input.parent !== undefined && parentOf(node.id) !== input.parent) return false;
        if (
          needle !== undefined &&
          ![item.title, item.description, item.kind === "task" ? (item.notes ?? "") : ""].some(
            (value) => value.toLowerCase().includes(needle),
          )
        )
          return false;
        if (
          input.assignee !== undefined &&
          (item.kind !== "task" || item.assignee !== input.assignee)
        )
          return false;
        if (input.view === "all") return true;
        if (item.kind === "gate") return false;
        if (item.state !== "open") return false;
        if (input.view === "ready") return ready(item.id);
        if (input.view === "waiting") return !ready(item.id);
        if (item.kind !== "task") return false;
        if (input.view === "assigned") return item.assignee !== null;
        if (input.view === "available")
          return ready(item.id) && item.assignee === null && item.audience === "AFK";
        return ready(item.id) && item.audience === "HITL" && item.assignee === human;
      })
      .map((node) => summary(node.id));
    if (
      input.view === "all" &&
      input.assignee === undefined &&
      input.audience === undefined &&
      input.origin === undefined &&
      input.parent === undefined
    ) {
      const ownedWork = q.eq(q.attr(workAttributes.item), true);
      const linked = graph.all({
        where: q.and(
          q.missing(q.attr(workAttributes.item)),
          q.or(
            q.edgeIn(workRelations.dependsOn, ownedWork),
            q.edgeIn(workRelations.references, ownedWork),
          ),
          ...(state === "all" ? [] : [q.eq("state", state === "open" ? "active" : "closed")]),
        ),
      });
      for (const node of linked) {
        if (node.reference === null) continue;
        if (input.kind !== undefined && node.reference.kind !== `work/${input.kind}`) continue;
        if (needle !== undefined && !node.title.toLowerCase().includes(needle)) continue;
        matches.push(summary(node.id));
      }
    }
    return page(
      matches.toSorted((a, b) => {
        const urgency = (a.priority ?? "P4").localeCompare(b.priority ?? "P4");
        return urgency === 0 ? a.id.localeCompare(b.id) : urgency;
      }),
      input.limit,
      input.offset,
    );
  }

  function tree(options: WorkTreeOptions = {}): WorkTopology {
    const parsed = treeInput.parse(options);
    return topologyDetails(projectTree(topologySource(false), parsed), parsed);
  }

  function topologyGraph(options: WorkGraphOptions = {}): WorkTopology {
    const parsed = graphInput.parse(options);
    return topologyDetails(projectGraph(topologySource(true), parsed), parsed);
  }

  function topologySource(includeReferences: boolean): TopologySource {
    const nodes = graph.all({
      where: q.eq(q.attr(workAttributes.item), true),
      includeArchived: true,
    });
    if (includeReferences) {
      const local = new Set(nodes.map((node) => node.id));
      const seen = new Set(local);
      for (const edge of graph.edges(undefined, workRelations.dependsOn)) {
        if (!local.has(edge.from_id) || seen.has(edge.to_id)) continue;
        const endpoint = graph.show(edge.to_id);
        if (endpoint.reference !== null) {
          nodes.push(endpoint);
          seen.add(endpoint.id);
        }
      }
    }
    const states = new Map(nodes.map((node) => [node.id, node.state]));
    const workEdges = (relation: string) =>
      graph
        .edges(undefined, relation)
        .filter((edge) => states.has(edge.from_id) && states.has(edge.to_id))
        .map((edge) => ({ from: edge.from_id, to: edge.to_id }));
    const parentEdges = workEdges(workRelations.parentOf);
    const dependencyEdges = workEdges(workRelations.dependsOn);
    const parents = new Map(parentEdges.map((edge) => [edge.to, edge.from]));
    const waiting = new Set(
      graph
        .edges(undefined, workRelations.dependsOn)
        .filter((edge) => states.has(edge.from_id) && !prerequisiteSatisfied(edge.to_id))
        .map((edge) => edge.from_id),
    );
    const summaries = nodes.map((node): WorkSummary => {
      if (node.reference !== null) return summary(node.id);
      const data = read(node);
      return {
        id: node.id,
        title: node.title,
        kind: data.kind,
        state: node.state === "closed" ? "closed" : "open",
        ready: node.state === "active" && !waiting.has(node.id),
        assignee: data.kind === "task" ? (currentAssignment(data)?.assignee ?? null) : null,
        audience: data.kind === "task" ? data.audience : null,
        origin: data.kind === "task" ? data.origin : null,
        priority: data.kind === "task" ? data.priority : null,
        parent: parents.get(node.id) ?? null,
        gate: data.kind === "gate" ? { probe: data.probe, status: data.status } : null,
      };
    });
    return { summaries, parentEdges, dependencyEdges };
  }

  function topologyDetails(view: WorkTopology, options: WorkTopologyOptions): WorkTopology {
    if (
      options.lean === true ||
      (options.showDescription !== true && options.showCriteria !== true)
    )
      return view;
    return {
      ...view,
      nodes: view.nodes.map((node) => {
        if ("kind" in node && node.kind === "reference") return node;
        const detail = get(node.id);
        return {
          ...node,
          ...(options.showDescription === true ? { description: detail.description } : {}),
          ...(options.showCriteria === true && detail.kind === "task"
            ? { acceptanceCriteria: detail.acceptanceCriteria }
            : {}),
        };
      }),
    };
  }

  function close(id: string, by?: string): WorkItem {
    return graph.atomic(() => {
      const item = get(id);
      if (item.kind === "gate")
        throw new Fault("work-gate", "Gates are updated only by gate record");
      if (item.state === "closed") return item;
      const data = read(graph.show(id));
      if (data.kind === "task") {
        const unresolved = data.criteria.filter(
          (criterion) => criterionView(criterion).state === "open",
        );
        if (unresolved.length > 0)
          throw new Fault("criteria", "Resolve every criterion before closing", {
            criteria: unresolved.map(({ id: criterionId }) => criterionId),
          });
        releaseCurrent(data, "closed", by);
      } else {
        assertClosedTasks(graph, id);
      }
      data.closures.push(attribution(by));
      graph.update(id, {
        state: "closed",
        attributes: attributesFor(data),
      });
      return get(id);
    }, authority);
  }

  function abandon(id: string, reason: string, by?: string) {
    const parsedReason = text.parse(reason);
    const actor = text.parse(requireValue(by, "Supply --by or caller identity"));
    return graph.atomic(() => {
      get(id);
      const tasks: string[] = [];
      const gates: string[] = [];
      const groups: string[] = [];

      const abandonItem = (itemId: string, requested: boolean): void => {
        const item = get(itemId);
        if (item.kind === "group")
          for (const child of outgoing(itemId, workRelations.parentOf)) abandonItem(child, false);

        const node = graph.show(itemId);
        const data = read(node);
        if (node.state === "closed") {
          if (requested) {
            const previous = data.abandonments.at(-1);
            if (previous !== undefined && previous.reason !== parsedReason)
              throw new Fault(
                "work-abandonment",
                "Abandonment retry must use the original reason",
                {
                  id: itemId,
                },
              );
            if (previous === undefined) {
              data.abandonments.push({
                by: actor,
                at: new Date(ctx.clock.now()).toISOString(),
                reason: parsedReason,
              });
              graph.setAttributes(itemId, attributesFor(data));
            }
          }
          return;
        }

        const abandoned = {
          by: actor,
          at: new Date(ctx.clock.now()).toISOString(),
          reason: parsedReason,
        };
        data.abandonments.push(abandoned);
        data.closures.push({ by: actor, at: abandoned.at });
        if (data.kind === "task") {
          releaseCurrent(data, parsedReason, actor);
          tasks.push(itemId);
        } else if (data.kind === "gate") {
          const from = data.status;
          data.status = { status: "dismissed", ...abandoned };
          gates.push(itemId);
          ctx.emit(workGateChanged, { id: itemId, from, to: data.status });
          graph.afterCommit(() => gateLifecycles.get(ctx)?.(itemId));
        } else {
          groups.push(itemId);
        }
        graph.update(itemId, { state: "closed", attributes: attributesFor(data) });
      };

      abandonItem(id, true);
      return {
        item: get(id),
        tasks,
        gates,
        groups,
        abandonment: requireValue(
          read(graph.show(id)).abandonments.at(-1),
          "Missing abandonment attribution",
        ),
      };
    }, authority);
  }

  function createGate(input: {
    title: string;
    description?: string;
    parent?: string;
    probe: string;
    params: JsonObject;
    policy: GatePolicy;
    dependents?: string[];
    by: string;
  }): Gate {
    const parsed = z
      .strictObject({
        title: text,
        description: z.string().default(""),
        parent: text.optional(),
        probe: text,
        params: jsonObjectSchema,
        policy: gatePolicySchema,
        dependents: z.array(text).default([]),
        by: text,
      })
      .parse(input);
    return graph.atomic(() => {
      const data: WorkData = {
        kind: "gate",
        description: parsed.description,
        closures: [],
        reopenings: [],
        abandonments: [],
        probe: parsed.probe,
        params: parsed.params,
        policy: parsed.policy,
        status: { status: "pending", round: 1 },
      };
      const node = graph.add({
        title: parsed.title,
        attributes: { [workAttributes.item]: true, ...attributesFor(data) },
      });
      if (parsed.parent !== undefined) move(node.id, parsed.parent);
      for (const dependent of parsed.dependents) link(dependent, node.id, workRelations.dependsOn);
      return getGate(node.id);
    }, authority);
  }

  function getGate(id: string): Gate {
    const item = get(id);
    if (item.kind !== "gate") throw new Fault("work-gate", "Expected a gate");
    return item;
  }

  function applyGate(id: string, raw: GateCommand): GateTransition {
    const command = gateCommandSchema.parse(raw);
    return graph.atomic(() => {
      const gate = getGate(id);
      const transition = transitionGate(gate, command);
      if (transition.kind === "refused") return transition;
      const data = read(graph.show(id));
      if (data.kind !== "gate") throw new Fault("work-gate", "Expected a gate");
      data.status = transition.to;
      if (transition.to.status === "cleared" || transition.to.status === "dismissed") {
        data.closures.push({ by: transition.to.by, at: transition.to.at });
      }
      graph.setAttributes(id, attributesFor(data));
      graph.update(id, {
        state:
          transition.to.status === "cleared" || transition.to.status === "dismissed"
            ? "closed"
            : "active",
      });
      ctx.emit(workGateChanged, { id, from: transition.from, to: transition.to });
      graph.afterCommit(() => {
        gateLifecycles.get(ctx)?.(id);
      });
      return transition;
    }, authority);
  }

  function reopen(id: string, reason: string, by?: string): WorkItem {
    text.parse(reason);
    return graph.atomic(() => {
      const item = get(id);
      if (item.state !== "closed") throw new Fault("work", "Only closed work can reopen");
      const data = read(graph.show(id));
      if (data.abandonments.length > 0)
        throw new Fault("work-abandonment", "Abandoned work is terminal; create follow-on work");
      if (data.kind === "gate")
        throw new Fault("work-gate", "Gates are updated only by gate record");
      data.reopenings.push({ ...attribution(by), reason });
      graph.update(id, {
        state: "active",
        attributes: attributesFor(data),
      });
      return get(id);
    }, authority);
  }

  function addCriterion(id: string, condition: string, by?: string): Criterion {
    return graph.atomic(() => {
      const data = openTask(id);
      const criterion: StoredCriterion = {
        id: crypto.randomUUID(),
        condition: text.parse(condition),
        ...attribution(by),
        changes: [],
      };
      data.criteria.push(criterion);
      save(id, data);
      return criterionView(criterion);
    }, authority);
  }

  function resolveCriterion(
    id: string,
    criterionId: string,
    resolution: string,
    by?: string,
    correct = false,
  ): Criterion {
    return changeCriterion(id, criterionId, resolution, by, correct ? "correct" : "resolve");
  }

  function reopenCriterion(
    id: string,
    criterionId: string,
    reason: string,
    by?: string,
  ): Criterion {
    return changeCriterion(id, criterionId, reason, by, "reopen");
  }

  function changeCriterion(
    id: string,
    criterionId: string,
    value: string,
    by: string | undefined,
    operation: "resolve" | "correct" | "reopen",
  ): Criterion {
    return graph.atomic(() => {
      const data = operation === "correct" ? taskData(id) : openTask(id);
      const criterion = requireValue(
        data.criteria.find((entry) => entry.id === criterionId),
        "Unknown criterion",
      );
      const state = criterionView(criterion).state;
      if (
        (operation === "resolve" && state !== "open") ||
        (operation !== "resolve" && state !== "resolved")
      )
        throw new Fault(
          "criteria",
          operation === "resolve"
            ? "Criterion already resolved; use an explicit correction"
            : "Only resolved criteria can be corrected or reopened",
        );
      criterion.changes.push({
        ...attribution(by),
        kind: operation === "reopen" ? "reopened" : "resolved",
        text: text.parse(value),
      });
      save(id, data);
      return criterionView(criterion);
    }, authority);
  }

  function claim(id: string, assignee?: string, by?: string): Assignment {
    return graph.atomic(() => {
      const data = openTask(id);
      const owner = text.parse(requireValue(assignee, "Supply --assignee or caller identity"));
      const current = currentAssignment(data);
      if (current !== null) {
        if (current.assignee === owner) {
          ctx.emit(workAssignmentEstablished, { task: id, assignment: current });
          return current;
        }
        throw new Fault(
          "assigned",
          "Task already assigned; release its current assignment before handoff",
          { assignmentId: current.id, assignee: current.assignee },
        );
      }
      if (!ready(id)) throw new Fault("waiting", "Resolve prerequisites before claiming");
      const assignment = newAssignment(owner, by);
      data.assignments.push(assignment);
      save(id, data);
      ctx.emit(workAssignmentEstablished, { task: id, assignment });
      return assignment;
    }, authority);
  }

  function release(id: string, assignmentId: string, reason: string, by?: string): boolean {
    text.parse(assignmentId);
    text.parse(reason);
    return graph.atomic(() => {
      const data = taskData(id);
      const current = currentAssignment(data);
      if (current?.id !== assignmentId) return false;
      current.release = { ...attribution(by), reason };
      save(id, data);
      return true;
    }, authority);
  }

  function move(id: string, parent: string | null): void {
    graph.atomic(() => {
      get(id);
      const previous = parentOf(id);
      if (previous === parent) return;
      if (previous !== null) graph.disconnect(previous, id, workRelations.parentOf);
      if (parent !== null) {
        const group = get(parent);
        if (group.kind !== "group") throw new Fault("context", "Only groups can contain work");
        graph.connect(parent, id, workRelations.parentOf);
      }
    }, authority);
  }

  function link(from: string, to: string, relation: WorkLinkRelation): void {
    graph.atomic(() => {
      const source = get(from);
      if (source.kind === "gate")
        throw new Fault("work-gate", "Gates cannot have prerequisites or references");
      const target = graph.show(to);
      if (target.reference === null) get(to);
      graph.connect(
        from,
        to,
        relation,
        relation === workRelations.dependsOn && target.reference !== null
          ? { [dependencyAttributes.referenceKinds]: [...requiredReferenceKinds] }
          : {},
      );
    }, authority);
  }

  function unlink(from: string, to: string, relation: WorkLinkRelation): void {
    graph.atomic(() => {
      get(from);
      if (graph.show(to).reference === null) get(to);
      graph.disconnect(from, to, relation);
    }, authority);
  }

  function ready(id: string): boolean {
    return (
      graph.show(id).state === "active" &&
      outgoing(id, workRelations.dependsOn).every((target) => prerequisiteSatisfied(target))
    );
  }

  function prerequisiteSatisfied(id: string): boolean {
    const node = graph.show(id);
    return node.reference === null
      ? get(id).state === "closed"
      : isWorkReference(node) && node.reference.status === "current" && node.state === "closed";
  }

  function parentOf(id: string): string | null {
    return (
      graph.edges(id, workRelations.parentOf).find((edge) => edge.to_id === id)?.from_id ?? null
    );
  }

  function outgoing(id: string, relation: string): string[] {
    return graph
      .edges(id, relation)
      .filter((edge) => edge.from_id === id)
      .map((edge) => edge.to_id);
  }

  function taskData(id: string) {
    const data = read(graph.show(id));
    if (data.kind !== "task") throw new Fault("work", "Only tasks are actionable");
    return data;
  }

  function openTask(id: string) {
    const data = taskData(id);
    if (graph.show(id).state !== "active")
      throw new Fault("work", "Reopen the task before changing its criteria or assignment");
    return data;
  }

  function save(id: string, data: WorkData): void {
    graph.setAttributes(id, attributesFor(data));
  }

  function attribution(by?: string) {
    return {
      by: text.parse(requireValue(by, "Supply --by or caller identity")),
      at: new Date(ctx.clock.now()).toISOString(),
    };
  }

  function newAssignment(assignee: string, by?: string): Assignment {
    return {
      id: crypto.randomUUID(),
      assignee: text.parse(assignee),
      ...attribution(by),
      release: null,
    };
  }

  function releaseCurrent(data: TaskData, reason: string, by?: string): void {
    const current = currentAssignment(data);
    if (current !== null) current.release = { ...attribution(by), reason };
  }

  const store: WorkStore = {
    create,
    get,
    update,
    inspect,
    summary,
    list,
    tree,
    graph: topologyGraph,
    close,
    abandon,
    gates: { create: createGate, apply: applyGate, get: getGate },
    reopen,
    addCriterion,
    resolveCriterion,
    reopenCriterion,
    claim,
    release,
    move,
    link,
    unlink,
  };
  stores.set(graph, store);
  return store;
}

// -- Storage and invariant enforcement --

function read(node: Node): WorkData {
  if (node.reference !== null)
    throw new Fault(
      "reference-read-only",
      "This work is owned by another lake; run the operation in its workspace",
      { id: node.id, ...node.reference },
    );
  if (node.attributes[workAttributes.item] !== true)
    throw new Fault("work", `Expected task or group: ${node.id}`);
  const attributes = node.attributes;
  return workDataSchema.parse({
    kind: attributes[workAttributes.kind],
    description: attributes[workAttributes.description],
    closures: attributes[workAttributes.closures],
    reopenings: attributes[workAttributes.reopenings],
    abandonments: attributes[workAttributes.abandonments],
    notes: attributes[workAttributes.notes] ?? null,
    audience: attributes[workAttributes.audience],
    origin: attributes[workAttributes.origin],
    priority: attributes[workAttributes.priority],
    probe: attributes[workAttributes.probe],
    params: attributes[workAttributes.params],
    policy: attributes[workAttributes.policy],
    status: attributes[workAttributes.status],
    criteria: attributes[workAttributes.criteria],
    assignments: attributes[workAttributes.assignments],
  });
}

function isWorkReference(node: Node): boolean {
  const reference = node.reference;
  return reference !== null && requiredReferenceKinds.some((kind) => kind === reference.kind);
}

function attributesFor(data: WorkData): Attributes {
  const common = {
    [workAttributes.kind]: data.kind,
    [workAttributes.description]: data.description,
    [workAttributes.closures]: data.closures,
    [workAttributes.reopenings]: data.reopenings,
    [workAttributes.abandonments]: data.abandonments,
  };
  if (data.kind === "group") return common;
  if (data.kind === "gate")
    return {
      ...common,
      [workAttributes.probe]: data.probe,
      [workAttributes.params]: data.params,
      [workAttributes.policy]: data.policy,
      [workAttributes.status]: jsonSchema.parse(data.status),
    };
  return {
    ...common,
    ...(data.notes === null ? {} : { [workAttributes.notes]: data.notes }),
    [workAttributes.audience]: data.audience,
    [workAttributes.origin]: data.origin,
    [workAttributes.priority]: data.priority,
    [workAttributes.criteria]: data.criteria,
    [workAttributes.assignments]: data.assignments,
  };
}

function criterionView(criterion: StoredCriterion): Criterion {
  const latest = criterion.changes.at(-1);
  const condition = { id: criterion.id, condition: criterion.condition };
  return latest?.kind === "resolved"
    ? {
        ...condition,
        state: "resolved",
        resolution: { text: latest.text, by: latest.by, at: latest.at },
      }
    : { ...condition, state: "open", resolution: null };
}

function currentAssignment(data: TaskData): Assignment | null {
  const latest = data.assignments.at(-1);
  return latest?.release === null ? latest : null;
}

function page<T>(items: T[], limit: number, offset: number): Page<T> {
  return {
    items: items.slice(offset, offset + limit),
    total: items.length,
    nextOffset: offset + limit < items.length ? offset + limit : null,
  };
}

function assertClosedTasks(graph: Graph, id: string): void {
  const pending = graph
    .subgraph(id)
    .nodes.filter(
      (node) =>
        node.attributes[workAttributes.item] === true &&
        read(node).kind === "task" &&
        node.state !== "closed",
    );
  if (pending.length > 0)
    throw new Fault("group-open", "Close all contained tasks before closing the group", {
      tasks: pending.map(({ id: taskId }) => taskId),
    });
}

function protect(graph: Graph, changes: readonly Mutation[], token: symbol | undefined): void {
  for (const change of changes) {
    if (change.kind === "node") {
      const { before, after } = change;
      const keys = new Set(
        [...Object.keys(before?.attributes ?? {}), ...Object.keys(after?.attributes ?? {})].filter(
          (key) => key.startsWith(workNamespace),
        ),
      );
      if (keys.size === 0) continue;
      if (after === null)
        throw new Fault(
          "work-history",
          "Work records are retained; close them instead of deleting",
        );
      const hot = graph.show(after.id, { includeArchived: false });
      for (const key of keys) {
        if (after.attributes[key] !== undefined && hot.attributes[key] === undefined)
          throw new Fault("work-history", "Work evidence cannot be archived");
        if (
          token !== authority &&
          canonical(before?.attributes[key] ?? null) !== canonical(after.attributes[key] ?? null)
        )
          throw new Fault("work-guard", "Work fields require the Work API");
      }
      if (
        token !== authority &&
        (before === null || before.state !== after.state || before.title !== after.title)
      )
        throw new Fault("work-guard", "Work lifecycle and title require the Work API");
      if (after.state === "replaced")
        throw new Fault("work-history", "Preserve completed scope; create follow-on work instead");
      const data = read(after);
      if (data.kind === "group" && graph.show(after.id).state === "closed")
        assertClosedTasks(graph, after.id);
      if (data.kind === "task" && graph.show(after.id).state === "active")
        assertOpenAncestors(graph, after.id);
      continue;
    }
    const edge = change.after ?? change.before;
    if (edge === null || !workRelationLabels.includes(edge.relation)) continue;
    const from = graph.all({ where: q.eq("id", edge.from_id), includeArchived: true })[0];
    const to = graph.all({ where: q.eq("id", edge.to_id), includeArchived: true })[0];
    if (
      from?.attributes[workAttributes.item] !== true &&
      to?.attributes[workAttributes.item] !== true
    )
      continue;
    if (
      (from !== undefined && from.reference !== null) ||
      (to !== undefined && to.reference !== null)
    ) {
      if (change.after === null) continue;
      if (
        from?.attributes[workAttributes.item] === true &&
        to !== undefined &&
        to.reference !== null &&
        edge.relation !== workRelations.parentOf
      ) {
        read(from);
        if (edge.relation === workRelations.dependsOn && !isWorkReference(to))
          throw new Fault(
            "work-links",
            "Work prerequisites must reference a source-verified task or group",
          );
        if (
          edge.relation === workRelations.dependsOn &&
          !requiredReferenceKindsSchema.safeParse(
            edge.attributes[dependencyAttributes.referenceKinds],
          ).success
        )
          throw new Fault(
            "work-links",
            "Remote Work prerequisites require the Work projection constraint; use work link",
            { field: dependencyAttributes.referenceKinds, expected: [...requiredReferenceKinds] },
          );
        continue;
      }
      throw new Fault(
        "work-links",
        "References can be prerequisite or reference targets, never local work or context",
      );
    }
    if (change.after === null) continue;
    if (
      from === undefined ||
      to === undefined ||
      from.attributes[workAttributes.item] !== true ||
      to.attributes[workAttributes.item] !== true
    )
      throw new Fault("work-links", "Work relationships connect tasks and groups only");
    read(from);
    read(to);
    if (edge.relation === workRelations.parentOf) {
      if (read(from).kind !== "group")
        throw new Fault("context", "Only groups can contain work; tasks are leaves");
      const parents = graph
        .edges(to.id, workRelations.parentOf)
        .filter((candidate) => candidate.to_id === to.id);
      if (parents.length > 1)
        throw new Fault(
          "context",
          "Work has at most one contextual parent; use references for other connections",
        );
      for (const node of graph.subgraph(to.id).nodes) {
        if (
          node.attributes[workAttributes.item] === true &&
          read(node).kind === "task" &&
          node.state === "active"
        )
          assertOpenAncestors(graph, node.id);
      }
    }
  }
}

function assertOpenAncestors(graph: Graph, id: string): void {
  let parent = graph.edges(id, workRelations.parentOf).find((edge) => edge.to_id === id)?.from_id;
  while (parent !== undefined) {
    const node = graph.show(parent);
    if (node.state === "closed")
      throw new Fault("context", "Reopen containing groups before introducing open tasks");
    parent = graph
      .edges(node.id, workRelations.parentOf)
      .find((edge) => edge.to_id === node.id)?.from_id;
  }
}
