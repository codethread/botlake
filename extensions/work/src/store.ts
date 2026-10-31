import {
  canonical,
  Fault,
  q,
  requireValue,
  type Context,
  type Graph,
  type Mutation,
  type Node,
} from "@botlake/core";
import { callerActor } from "@botlake/extension-identity";
import { z } from "zod";

import { workAssignmentEstablished } from "./events.ts";
import {
  taskDataSchema,
  text,
  workAttributes,
  workDataSchema,
  workNamespace,
  workRelations,
  type StoredCriterion,
  type TaskData,
  type WorkData,
  type WorkLinkRelation,
} from "./node-model.ts";
import type {
  Assignment,
  CreateItem,
  Criterion,
  Group,
  ListOptions,
  Page,
  UpdateItem,
  WorkDetail,
  WorkItem,
  WorkStore,
  WorkSummary,
} from "./types.ts";

const authority = Symbol("work");
const stores = new WeakMap<Graph, WorkStore>();
const workRelationLabels: readonly string[] = Object.values(workRelations);
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
    kind: z.enum(["task", "group"]).optional(),
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
      const base = { description: input.description, closures: [], reopenings: [] };
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
        attributes: { [workAttributes.item]: true, [workAttributes.data]: JSON.stringify(data) },
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
      if (Object.keys(input).every((key) => key === "expectedRevision"))
        throw new Fault("work", "Supply a field to update");
      if (
        item.state === "closed" &&
        Object.keys(input).some((key) => key !== "notes" && key !== "expectedRevision")
      )
        throw new Fault("work", "Preserve completed scope; reopen for recovery or create new work");
      if (
        data.kind === "group" &&
        [input.notes, input.audience, input.origin, input.priority].some(
          (value) => value !== undefined,
        )
      )
        throw new Fault("work", "Groups supply context, not task fields");
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
        attributes: { [workAttributes.data]: JSON.stringify(data) },
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
            },
          }
        : {}),
    };
  }

  function summary(id: string): WorkSummary {
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
    };
  }

  function list(raw: ListOptions = {}): Page<WorkSummary> {
    const input = listInput.parse(raw);
    const state = input.state ?? (input.search === undefined ? "open" : "all");
    const human =
      input.view === "human"
        ? requireValue(
            input.assignee ?? callerActor(ctx),
            "Supply --assignee or BL_ACTOR for the human queue",
          )
        : undefined;
    const needle = input.search?.toLowerCase();
    const matches = graph
      .all({ where: q.eq(q.attr(workAttributes.item), true), lean: false })
      .filter((node) => {
        const item = get(node.id);
        if (state !== "all" && item.state !== state) return false;
        if (input.kind !== undefined && item.kind !== input.kind) return false;
        if (input.parent !== undefined && parentOf(node.id) !== input.parent) return false;
        if (
          needle !== undefined &&
          ![item.title, item.description, item.kind === "task" ? (item.notes ?? "") : ""].some(
            (value) => value.toLowerCase().includes(needle),
          )
        )
          return false;
        if (input.origin !== undefined && (item.kind !== "task" || item.origin !== input.origin))
          return false;
        if (
          input.audience !== undefined &&
          (item.kind !== "task" || item.audience !== input.audience)
        )
          return false;
        if (
          input.assignee !== undefined &&
          (item.kind !== "task" || item.assignee !== input.assignee)
        )
          return false;
        if (input.view === "all") return true;
        if (item.state !== "open") return false;
        if (input.view === "ready") return ready(item.id);
        if (input.view === "waiting") return !ready(item.id);
        if (item.kind !== "task") return false;
        if (input.view === "assigned") return item.assignee !== null;
        if (input.view === "available")
          return ready(item.id) && item.assignee === null && item.audience === "AFK";
        return ready(item.id) && item.audience === "HITL" && item.assignee === human;
      })
      .map((node) => summary(node.id))
      .toSorted((a, b) => {
        const urgency = (a.priority ?? "P4").localeCompare(b.priority ?? "P4");
        return urgency === 0 ? a.id.localeCompare(b.id) : urgency;
      });
    return page(matches, input.limit, input.offset);
  }

  function close(id: string, by?: string): WorkItem {
    return graph.atomic(() => {
      const item = get(id);
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
        attributes: { [workAttributes.data]: JSON.stringify(data) },
      });
      return get(id);
    }, authority);
  }

  function reopen(id: string, reason: string, by?: string): WorkItem {
    text.parse(reason);
    return graph.atomic(() => {
      const item = get(id);
      if (item.state !== "closed") throw new Fault("work", "Only closed work can reopen");
      const data = read(graph.show(id));
      data.reopenings.push({ ...attribution(by), reason });
      graph.update(id, {
        state: "active",
        attributes: { [workAttributes.data]: JSON.stringify(data) },
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
      const owner = text.parse(
        requireValue(assignee ?? callerActor(ctx), "Supply --assignee or BL_ACTOR"),
      );
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
      get(from);
      get(to);
      graph.connect(from, to, relation);
    }, authority);
  }

  function unlink(from: string, to: string, relation: WorkLinkRelation): void {
    graph.atomic(() => {
      get(from);
      get(to);
      graph.disconnect(from, to, relation);
    }, authority);
  }

  function ready(id: string): boolean {
    return (
      graph.show(id).state === "active" &&
      outgoing(id, workRelations.dependsOn).every((target) => get(target).state === "closed")
    );
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
    graph.update(id, { attributes: { [workAttributes.data]: JSON.stringify(data) } });
  }

  function attribution(by?: string) {
    return {
      by: text.parse(requireValue(by ?? callerActor(ctx), "Supply --by or BL_ACTOR")),
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
    close,
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
  if (node.attributes[workAttributes.item] !== true)
    throw new Fault("work", `Expected task or group: ${node.id}`);
  return workDataSchema.parse(JSON.parse(text.parse(node.attributes[workAttributes.data])));
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
      const hot = graph.show(after.id, true);
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
    const from = graph.all({ where: q.eq("id", edge.from_id), lean: false })[0];
    const to = graph.all({ where: q.eq("id", edge.to_id), lean: false })[0];
    if (
      from?.attributes[workAttributes.item] !== true &&
      to?.attributes[workAttributes.item] !== true
    )
      continue;
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
