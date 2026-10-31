import {
  canonical,
  Fault,
  jsonSchema,
  requireValue,
  type Context,
  type Graph,
  type Json,
  type Node,
} from "@botlake/core";
import { callerActor } from "@botlake/extension-identity";
import { workStore, type Page, type WorkStore, type WorkSummary } from "@botlake/extension-work";
import { z } from "zod";

import { type Catalogue, type Selection } from "./catalogue.ts";
import {
  currentStatus,
  initialActor,
  renderTask,
  resolvedTaskSchema,
  restoredActor,
  snapshotFor,
  targetActor,
  type Definition,
  type WorkflowActor,
} from "./definition.ts";
import { frontier, type Entry } from "./frontier.ts";
import {
  workflowAttributes,
  workflowLocatorSchema,
  workflowNamespace,
  workflowRelationNamespace,
  workflowRelations,
  workflowResultSchema,
  workflowSnapshotSchema,
} from "./node-model.ts";

const text = z.string().min(1);
const contextSchema = z.record(z.string(), z.unknown());
const briefSchema = z.strictObject({ title: text, description: z.string() });
const showOptionsSchema = z.compile(
  z.strictObject({
    limit: z.number().int().min(1).max(100).default(20),
    offset: z.number().int().nonnegative().default(0),
    historyOffset: z.number().int().nonnegative().default(0),
  }),
);

interface Visit {
  node: Node;
  key: string;
  path: string[];
  context: Record<string, unknown>;
  meta: z.infer<typeof resolvedTaskSchema>;
}

interface Submission {
  visit: Visit;
  choice: string;
  data: unknown;
}

export function workflowRun(graph: Graph, id: string): Node {
  const node = graph.show(id);
  if (node.attributes[workflowAttributes.root] !== true)
    throw new Fault("workflow", `Expected a workflow run: ${id}`);
  return node;
}

/** Restores, advances, checkpoints and publishes one authored workflow transactionally. */
export function workflowService(ctx: Context, catalogue: Catalogue) {
  const graph = ctx.graph;
  const work = workStore(ctx);
  const authority = Symbol("workflow");
  for (const marker of [
    workflowAttributes.root,
    workflowAttributes.visit,
    workflowAttributes.task,
    workflowAttributes.group,
  ])
    graph.declareImmutable(marker);
  protectWorkflow(graph, authority);

  async function catalog(selection?: Selection): Promise<Json> {
    if (selection === undefined) return serialise(await catalogue.list());
    const loaded = await catalogue.load(selection);
    return serialise({
      definition: loaded.locator,
      source: loaded.source,
      input: z.toJSONSchema(loaded.definition.inputSchema, { io: "input" }),
      constraints: loaded.definition.inputConstraints,
    });
  }

  async function start(selection: Selection, input: Json, parent?: string): Promise<Json> {
    const loaded = await catalogue.load(selection);
    const hint =
      loaded.locator.kind === "named"
        ? `bl workflow catalog ${loaded.locator.name}`
        : `bl workflow catalog --source ${JSON.stringify(loaded.locator.source)}`;
    const parsed = parseInput(
      loaded.definition.inputSchema,
      input,
      `Inspect the input schema: ${hint}`,
    );
    const brief = briefSchema.parse(loaded.definition.runBrief(parsed));
    return graph.atomic(() => {
      if (parent !== undefined) {
        const candidate = work.get(parent);
        if (candidate.kind !== "group" || candidate.state !== "open")
          throw new Fault("workflow", "Workflow parent must be an open Work group");
      }
      const actor = initialActor(loaded.definition, parsed);
      try {
        const context = work.create({
          kind: "group",
          title: brief.title,
          description: brief.description,
          parent,
        });
        const run = graph.add({
          title: `Workflow execution ${context.id}`,
          attributes: {
            [workflowAttributes.root]: true,
            [workflowAttributes.private]: true,
            [workflowAttributes.contextGroup]: context.id,
            [workflowAttributes.definition]: JSON.stringify(loaded.locator),
          },
        });
        publish(run, actor, []);
        return view(run.id);
      } finally {
        actor.stop();
      }
    }, authority);
  }

  async function show(
    id: string,
    options: { limit?: number; offset?: number; historyOffset?: number } = {},
  ): Promise<Json> {
    const run =
      graph.show(id).attributes[workflowAttributes.root] === true
        ? workflowRun(graph, id)
        : containingRun(id);
    if (id === run.id) return view(run.id, showOptionsSchema.parse(options));
    const node = graph.show(id);
    if (node.attributes[workflowAttributes.task] !== true)
      throw new Fault("workflow", "Show a workflow run or worker task");
    const loaded = await loadRun(run);
    const visit = visitFor(node);
    const { commands, ...metadata } = visit.meta;
    const detail = work.inspect(id, { history: true, limit: 20 });
    return serialise({
      run: runSummary(run),
      tasks: [
        {
          ...loaded.definition.describe?.(taskEntry(visit)),
          ...metadata,
          ...taskSummary(node),
          work: detail,
          instructions: visit.meta.instructions,
          stateNode: node.attributes[workflowAttributes.state],
          visit: node.attributes[workflowAttributes.number],
          context: visit.context,
          choices: Object.fromEntries(
            Object.keys(commands ?? {}).map((choice) => [
              choice,
              { schema: z.toJSONSchema(commandSchema(loaded.definition, choice), { io: "input" }) },
            ]),
          ),
          result: node.attributes[workflowAttributes.consumed] === true ? savedResult(node) : null,
          completedBy: node.attributes[workflowAttributes.completedBy] ?? null,
        },
      ],
    });
  }

  async function complete(taskId: string, choice: string, data: Json): Promise<Json> {
    const run = containingRun(taskId);
    const node = graph.show(taskId);
    if (node.attributes[workflowAttributes.task] !== true)
      throw new Fault("workflow", "Complete a workflow worker task");
    if (node.attributes[workflowAttributes.consumed] === true) {
      assertMatchingResult(node, choice, data);
      return view(run.id);
    }
    const loaded = await loadRun(run);
    return graph.atomic(() => {
      const current = graph.show(taskId);
      if (current.attributes[workflowAttributes.consumed] === true) {
        assertMatchingResult(current, choice, data);
        return view(run.id);
      }
      assertRunning(graph.show(run.id));
      assertDirectPrerequisitesClosed(work, taskId);
      const previous = active(run.id);
      const visit = requireValue(
        previous.find((entry) => entry.node.id === taskId),
        "No current worker visit",
      );
      const parsed = validateResult(loaded.definition, visit, choice, data);
      const actorName = requireValue(callerActor(ctx), "Supply BL_ACTOR to attribute completion");
      const actor = restore(run.id, loaded.definition);
      try {
        advance(actor, { visit, choice, data: parsed });
        const sequence =
          memberNodes(run.id).filter(
            (item) => item.attributes[workflowAttributes.consumed] === true,
          ).length + 1;
        if (work.get(taskId).state === "open") work.close(taskId, actorName);
        graph.update(taskId, {
          attributes: {
            [workflowAttributes.result]: JSON.stringify({ choice, data }),
            [workflowAttributes.consumed]: true,
            [workflowAttributes.completionOrder]: sequence,
            [workflowAttributes.completedBy]: actorName,
          },
        });
        graph.disconnect(run.id, taskId, workflowRelations.active);
        publish(
          run,
          actor,
          previous.filter((entry) => entry.node.id !== taskId),
          actorName,
        );
        return view(run.id);
      } finally {
        actor.stop();
      }
    }, authority);
  }

  return { catalog, start, show, complete };

  function publish(run: Node, actor: WorkflowActor, previous: Visit[], by?: string): void {
    const current = frontier(actor);
    const keys = new Set(current.map((entry) => entry.key));
    for (const old of previous.toReversed()) {
      if (keys.has(old.key)) continue;
      if (old.meta.commands !== undefined)
        throw new Fault("workflow", "Transition would discard unconsumed work", {
          task: old.node.id,
        });
      graph.disconnect(run.id, old.node.id, workflowRelations.active);
      closeDepartedGroup(old.node.id, by);
    }

    const retained = new Map(previous.map((visit) => [visit.key, visit]));
    const published = new Map<string, Node>();
    const history = memberNodes(run.id).filter(
      (candidate) => candidate.attributes[workflowAttributes.visit] === true,
    );
    for (const entry of current) {
      const existing = retained.get(entry.key);
      if (existing !== undefined) {
        published.set(entry.key, existing.node);
        continue;
      }
      const parent = nearestGroup(run, entry, current, published, retained);
      const node = enter(run, parent, entry, history);
      published.set(entry.key, node);
      history.push(node);
    }
    graph.update(run.id, {
      attributes: {
        [workflowAttributes.snapshot]: JSON.stringify(snapshotFor(actor)),
        [workflowAttributes.checkpointBy]: by ?? null,
      },
    });
    if (currentStatus(actor) === "done") {
      graph.update(run.id, { state: "closed" });
      closeDepartedGroup(runContext(run), by);
    }
  }

  function nearestGroup(
    run: Node,
    entry: Entry,
    current: Entry[],
    published: Map<string, Node>,
    retained: Map<string, Visit>,
  ): string {
    let parentKey = entry.parent;
    while (parentKey !== undefined) {
      const candidateKey = parentKey;
      const parentEntry = requireValue(
        current.find((candidate) => candidate.key === candidateKey),
        `Missing published state parent ${parentKey}`,
      );
      const parent = requireValue(
        published.get(parentKey) ?? retained.get(parentKey)?.node,
        `Missing published state ${parentKey}`,
      );
      if (work.get(parent.id).kind === "group") return parent.id;
      parentKey = parentEntry.parent;
    }
    return runContext(run);
  }

  function enter(run: Node, parent: string, entry: Entry, history: Node[]): Node {
    const meta = renderTask(entry.meta, entry.context);
    const worker = meta.commands !== undefined;
    if (
      !worker &&
      [
        meta.acceptanceCriteria,
        meta.assignee,
        meta.audience,
        meta.origin,
        meta.priority,
        meta.notes,
      ].some((value) => value !== undefined)
    )
      throw new Fault("workflow", "Commandless context groups cannot declare task fields");
    const number =
      history.filter((node) => node.attributes[workflowAttributes.key] === entry.key).length + 1;
    const item = worker
      ? work.create({
          kind: "task",
          title: meta.title,
          description: meta.instructions,
          parent,
          ...taskAuthorship(meta),
        })
      : work.create({
          kind: "group",
          title: meta.title,
          description: meta.instructions,
          parent,
        });
    graph.update(item.id, {
      attributes: {
        [workflowAttributes.visit]: true,
        [worker ? workflowAttributes.task : workflowAttributes.group]: true,
        [workflowAttributes.state]: entry.node,
        [workflowAttributes.key]: entry.key,
        [workflowAttributes.path]: entry.path,
        [workflowAttributes.number]: number,
        [workflowAttributes.order]: history.length + 1,
        [workflowAttributes.context]: JSON.stringify(entry.context),
        [workflowAttributes.meta]: JSON.stringify(meta),
      },
    });
    graph.connect(run.id, item.id, workflowRelations.member);
    graph.connect(run.id, item.id, workflowRelations.active);
    return graph.show(item.id);
  }

  function closeDepartedGroup(id: string, by?: string): void {
    const item = work.get(id);
    if (item.kind !== "group" || item.state === "closed" || hasOpenDescendantTask(work, id)) return;
    work.close(id, by);
  }

  function active(id: string): Visit[] {
    return graph
      .edges(id, workflowRelations.active)
      .filter((edge) => edge.from_id === id)
      .map((edge) => graph.show(edge.to_id))
      .toSorted(
        (a, b) =>
          z.number().parse(a.attributes[workflowAttributes.order]) -
          z.number().parse(b.attributes[workflowAttributes.order]),
      )
      .map((node) => visitFor(node));
  }

  function memberNodes(id: string): Node[] {
    return graph
      .edges(id, workflowRelations.member)
      .filter((edge) => edge.from_id === id)
      .map((edge) => graph.show(edge.to_id));
  }

  function visitFor(node: Node): Visit {
    return {
      node,
      key: text.parse(node.attributes[workflowAttributes.key]),
      path: z.array(z.string()).parse(node.attributes[workflowAttributes.path]),
      context: contextSchema.parse(
        JSON.parse(text.parse(node.attributes[workflowAttributes.context])),
      ),
      meta: resolvedTaskSchema.parse(
        JSON.parse(text.parse(node.attributes[workflowAttributes.meta])),
      ),
    };
  }

  function taskSummary(node: Node) {
    const summary = work.summary(node.id);
    return {
      id: summary.id,
      title: summary.title,
      status: summary.state === "closed" ? "done" : summary.ready ? "ready" : "blocked",
      assignee: summary.assignee,
      audience: summary.audience,
      priority: summary.priority,
      actionPending: node.attributes[workflowAttributes.consumed] !== true,
    };
  }

  function runSummary(run: Node) {
    const activeTasks = active(run.id).filter(
      (visit) => visit.node.attributes[workflowAttributes.task] === true,
    );
    return {
      id: run.id,
      context: runContext(run),
      title: work.get(runContext(run)).title,
      status:
        run.state === "closed"
          ? "complete"
          : activeTasks.some((visit) =>
                work
                  .inspect(visit.node.id)
                  .prerequisites.every((prerequisite) => prerequisite.state === "closed"),
              )
            ? "active"
            : "blocked",
    };
  }

  function view(id: string, options = showOptionsSchema.parse({})): Json {
    const run = workflowRun(graph, id);
    const tasks = active(id)
      .filter((visit) => visit.node.attributes[workflowAttributes.task] === true)
      .map((visit) => taskSummary(visit.node));
    const history = memberNodes(id)
      .filter((node) => node.attributes[workflowAttributes.consumed] === true)
      .toSorted(
        (a, b) =>
          z.number().parse(a.attributes[workflowAttributes.completionOrder]) -
          z.number().parse(b.attributes[workflowAttributes.completionOrder]),
      );
    return serialise({
      run: runSummary(run),
      tasks: tasks.slice(options.offset, options.offset + options.limit),
      taskPage: {
        total: tasks.length,
        nextOffset:
          options.offset + options.limit < tasks.length ? options.offset + options.limit : null,
      },
      history: history
        .slice(options.historyOffset, options.historyOffset + options.limit)
        .map((node) => ({
          id: node.id,
          title: work.get(node.id).title,
          choice: savedResult(node).choice,
        })),
      historyPage: {
        total: history.length,
        nextOffset:
          options.historyOffset + options.limit < history.length
            ? options.historyOffset + options.limit
            : null,
      },
    });
  }

  async function loadRun(run: Node) {
    return catalogue.restore(
      workflowLocatorSchema.parse(
        JSON.parse(text.parse(run.attributes[workflowAttributes.definition])),
      ),
    );
  }

  function restore(id: string, definition: Definition): WorkflowActor {
    const run = workflowRun(graph, id);
    return restoredActor(
      definition,
      workflowSnapshotSchema.parse(
        JSON.parse(text.parse(run.attributes[workflowAttributes.snapshot])),
      ),
    );
  }

  function containingRun(id: string): Node {
    const roots = graph
      .edges(id, workflowRelations.member)
      .filter((edge) => edge.to_id === id)
      .map((edge) => graph.show(edge.from_id))
      .filter((node) => node.attributes[workflowAttributes.root] === true);
    if (roots.length !== 1) throw new Fault("workflow", `Expected one workflow run for ${id}`);
    return requireValue(roots[0], "Missing workflow run");
  }
}

function taskAuthorship(meta: z.infer<typeof resolvedTaskSchema>) {
  return {
    acceptanceCriteria: meta.acceptanceCriteria,
    notes: meta.notes,
    assignee: meta.assignee,
    audience: meta.audience,
    origin: meta.origin,
    priority: meta.priority,
  };
}

function hasOpenDescendantTask(work: WorkStore, root: string): boolean {
  const pending = [root];
  while (pending.length > 0) {
    const parent = requireValue(pending.pop(), "Missing group traversal entry");
    let offset: number | null = 0;
    while (offset !== null) {
      const page: Page<WorkSummary> = work.inspect(parent, { limit: 100, offset }).members;
      for (const member of page.items) {
        if (member.kind === "task" && member.state === "open") return true;
        if (member.kind === "group") pending.push(member.id);
      }
      offset = page.nextOffset;
    }
  }
  return false;
}

function assertDirectPrerequisitesClosed(work: WorkStore, id: string): void {
  const blockers = work
    .inspect(id, { limit: 100 })
    .prerequisites.filter((prerequisite) => prerequisite.state !== "closed");
  if (blockers.length > 0)
    throw new Fault("workflow", "Finish direct prerequisites before completing this task", {
      blockers: blockers.map(({ id: blocker }) => blocker),
    });
}

function protectWorkflow(graph: Graph, authority: symbol): void {
  graph.protect((changes, token) => {
    for (const change of changes) {
      if (change.kind === "edge") {
        const edge = change.before ?? change.after;
        if (edge?.relation.startsWith(workflowRelationNamespace) === true && token !== authority)
          throw new Fault("workflow", "Workflow execution links are private");
        continue;
      }
      const { before, after } = change;
      const keys = new Set(
        [...Object.keys(before?.attributes ?? {}), ...Object.keys(after?.attributes ?? {})].filter(
          (key) => key.startsWith(workflowNamespace),
        ),
      );
      if (keys.size === 0) continue;
      if (after === null) throw new Fault("workflow", "Workflow execution evidence is retained");
      const hot = graph.show(after.id, true);
      for (const key of keys) {
        if (after.attributes[key] !== undefined && hot.attributes[key] === undefined)
          throw new Fault("workflow", "Workflow evidence cannot be archived");
        if (
          token !== authority &&
          canonical(before?.attributes[key] ?? null) !== canonical(after.attributes[key] ?? null)
        )
          throw new Fault("workflow", "Workflow execution fields require authored actions");
      }
      if (
        before?.attributes[workflowAttributes.root] === true &&
        token !== authority &&
        (before.state !== after.state || before.title !== after.title)
      )
        throw new Fault("workflow", "Workflow execution lifecycle is private");
      if (before?.attributes[workflowAttributes.consumed] === true && after.state === "active")
        throw new Fault("workflow", "Consumed workflow visits cannot be reopened");
    }
  });
}

function assertRunning(run: Node): void {
  if (run.state !== "active")
    throw new Fault("workflow", "Workflow is complete; start a fresh run for new work");
}

function runContext(run: Node): string {
  return text.parse(run.attributes[workflowAttributes.contextGroup]);
}

function savedResult(node: Node) {
  return workflowResultSchema.parse(
    JSON.parse(text.parse(node.attributes[workflowAttributes.result])),
  );
}

function assertMatchingResult(node: Node, choice: string, data: Json): void {
  if (canonical(savedResult(node)) !== canonical({ choice, data }))
    throw new Fault("workflow", "Visit already has a different saved original result", {
      task: node.id,
    });
}

function commandSchema(definition: Definition, choice: string): z.ZodType {
  return requireValue(definition.commandSchemas[choice], `Missing command schema for ${choice}`);
}

function taskEntry(visit: Visit) {
  return { bead: visit.node.id, context: visit.context, meta: visit.meta };
}

function validateResult(
  definition: Definition,
  visit: Visit,
  choice: string,
  data: unknown,
): unknown {
  if (visit.meta.commands?.[choice] === undefined)
    throw new Fault("workflow", `Choice ${choice} is unavailable for ${visit.node.id}`, {
      choices: Object.keys(visit.meta.commands ?? {}),
    });
  const parsed = parseInput(commandSchema(definition, choice), data);
  definition.validateCommand?.(taskEntry(visit), choice, parsed);
  return parsed;
}

function advance(root: WorkflowActor, submission: Submission): void {
  const { actor, type } = submissionTarget(root, submission);
  actor.send({ type, data: submission.data });
  if (root.getSnapshot().status === "error")
    throw new Fault("workflow", `XState transition failed: ${String(root.getSnapshot().error)}`);
}

function submissionTarget(root: WorkflowActor, submission: Submission) {
  const { visit, choice, data } = submission;
  const actor = targetActor(root, visit.path);
  const type = requireValue(
    visit.meta.commands?.[choice],
    `Choice ${choice} is unavailable for ${visit.node.id}`,
  );
  if (!actor.getSnapshot().can({ type, data }))
    throw new Fault("workflow", `Choice ${choice} is unavailable for ${visit.node.id}`, {
      choices: Object.keys(visit.meta.commands ?? {}),
    });
  return { actor, type };
}

function parseInput<T>(schema: z.ZodType<T>, input: unknown, hint?: string): T {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  throw new Fault("validation", "input schema validation failed", [
    ...parsed.error.issues.map((issue) => ({
      message: issue.message,
      path: issue.path.map((key) => (typeof key === "symbol" ? String(key) : key)),
    })),
    ...(hint === undefined ? [] : [{ message: hint }]),
  ]);
}

function serialise(value: unknown): Json {
  return jsonSchema.parse(JSON.parse(JSON.stringify(value)));
}
