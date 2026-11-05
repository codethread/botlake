import {
  canonical,
  Fault,
  jsonSchema,
  q,
  requireValue,
  type Context,
  type Graph,
  type Json,
  type Node,
} from "@botlake/core";
import { workStore, type Page, type WorkStore, type WorkSummary } from "@botlake/extension-work";
import { createActor, type Snapshot, type Subscription } from "xstate";
import { z } from "zod";

import { type Catalogue, type Selection } from "./catalogue.ts";
import {
  invocations,
  renderTask,
  resolvedTaskSchema,
  targetActor,
  type Definition,
  type ResolvedTask,
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
  meta: ResolvedTask;
}

interface LiveRun {
  actor: WorkflowActor;
  definition: Definition;
  by: string;
  status: "running" | "stopped";
  dirty: boolean;
  queued: boolean;
  observer: Subscription;
}

export function workflowRun(graph: Graph, id: string): Node {
  const node = graph.show(id);
  if (node.attributes[workflowAttributes.root] !== true)
    throw new Fault("workflow", `Expected a workflow run: ${id}`);
  return node;
}

/** XState owns execution; metadata snapshots project into Work. */
export function workflowService(ctx: Context, catalogue: Catalogue) {
  const graph = ctx.graph;
  const work = workStore(ctx);
  const authority = Symbol("workflow");
  const live = new Map<string, LiveRun>();
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

  async function start(
    selection: Selection,
    input: Json,
    parent: string | undefined,
    callerIdentity: string | null,
  ): Promise<Json> {
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
    const actorName = requireValue(callerIdentity, "Supply caller identity to start a workflow");
    const runId = graph.atomic(() => {
      if (parent !== undefined) {
        const candidate = work.get(parent);
        if (candidate.kind !== "group" || candidate.state !== "open")
          throw new Fault("workflow", "Workflow parent must be an open Work group");
      }
      const context = work.create({
        kind: "group",
        title: brief.title,
        description: brief.description,
        parent,
        by: actorName,
      });
      return graph.add({
        title: `Workflow execution ${context.id}`,
        attributes: {
          [workflowAttributes.root]: true,
          [workflowAttributes.private]: true,
          [workflowAttributes.contextGroup]: context.id,
          [workflowAttributes.definition]: loaded.locator,
          [workflowAttributes.checkpointBy]: actorName,
          [workflowAttributes.invocations]: [],
        },
      }).id;
    }, authority);
    try {
      launch(runId, loaded.definition, { input: parsed }, actorName);
    } catch (error) {
      fail(runId, live.get(runId), error);
      throw error;
    }
    return view(runId);
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
    const visit = visitFor(node);
    const loaded = await loadRun(run);
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

  async function complete(
    taskId: string,
    choice: string,
    data: Json,
    callerIdentity: string | null,
  ): Promise<Json> {
    const run = containingRun(taskId);
    const node = graph.show(taskId);
    if (node.attributes[workflowAttributes.task] !== true)
      throw new Fault("workflow", "Complete a workflow worker task");
    if (node.attributes[workflowAttributes.consumed] === true) {
      assertMatchingResult(node, choice, data);
      return view(run.id);
    }
    assertRunning(run);
    const session = requireValue(live.get(run.id), "Workflow has no live actor; inspect its error");
    const visit = requireValue(
      active(run.id).find((entry) => entry.node.id === taskId),
      "No current worker visit",
    );
    const parsed = validateResult(session.definition, visit, choice, data);
    const actor = targetActor(session.actor, visit.path);
    const type = requireValue(visit.meta.commands?.[choice], `Unknown choice ${choice}`);
    const event = { type, data: parsed };
    if (!actor.getSnapshot().can(event))
      throw new Fault("workflow", `Choice ${choice} is unavailable for ${taskId}`);
    const by = requireValue(callerIdentity, "Supply caller identity to attribute completion");
    let advanced = false;
    try {
      graph.atomic(() => {
        assertDirectPrerequisitesClosed(work, taskId);
        if (work.get(taskId).state === "open") work.close(taskId, by);
        graph.setAttributes(taskId, {
          [workflowAttributes.result]: { choice, data },
          [workflowAttributes.consumed]: true,
          [workflowAttributes.completionOrder]:
            memberNodes(run.id).filter(
              (item) => item.attributes[workflowAttributes.consumed] === true,
            ).length + 1,
          [workflowAttributes.completedBy]: by,
        });
        graph.disconnect(run.id, taskId, workflowRelations.active);
        session.by = by;
        advanced = true;
        actor.send(event);
        checkpoint(run.id, session);
      }, authority);
    } catch (error) {
      if (advanced) fail(run.id, session, error);
      throw error;
    }
    return view(run.id);
  }

  async function resume(): Promise<void> {
    for (const run of graph.all({ where: q.eq(q.attr(workflowAttributes.root), true) })) {
      if (run.state !== "active" || run.attributes[workflowAttributes.error] !== undefined)
        continue;
      try {
        const loaded = await loadRun(run);
        const snapshot = workflowSnapshotSchema.parse(
          JSON.parse(text.parse(run.attributes[workflowAttributes.snapshot])),
        );
        launch(
          run.id,
          loaded.definition,
          { snapshot },
          text.parse(run.attributes[workflowAttributes.checkpointBy]),
        );
      } catch (error) {
        fail(run.id, live.get(run.id), error);
      }
    }
  }

  function stop(): void {
    for (const [id, session] of live) {
      try {
        if (session.dirty) checkpoint(id, session);
      } catch (error) {
        fail(id, session, error);
      } finally {
        stopActor(session);
      }
    }
    live.clear();
  }

  return { catalog, start, show, complete, resume, stop };

  function launch(
    id: string,
    definition: Definition,
    state: { input: unknown } | { snapshot: Snapshot<unknown> },
    by: string,
  ): void {
    const actor = createActor(definition.machine, state);
    const observer = actor.system.inspect((event) => {
      if (event.type === "@xstate.snapshot") changed(id, session);
    });
    const session: LiveRun = {
      actor,
      definition,
      by,
      status: "running",
      dirty: false,
      queued: false,
      observer,
    };
    // Errors are persisted by the same checkpoint path, not rethrown by XState's observer machinery.
    actor.subscribe({
      error: () => {
        changed(id, session);
      },
    });
    live.set(id, session);
    actor.start();
    checkpoint(id, session);
  }

  function changed(id: string, session: LiveRun): void {
    if (session.status !== "running") return;
    session.dirty = true;
    if (session.queued) return;
    session.queued = true;
    // Child onDone/sendParent transitions must finish before reading the whole actor tree.
    queueMicrotask(() => {
      session.queued = false;
      if (!session.dirty || session.status !== "running") return;
      try {
        checkpoint(id, session);
      } catch (error) {
        fail(id, session, error);
      }
    });
  }

  function checkpoint(id: string, session: LiveRun): void {
    session.dirty = false;
    const snapshot = session.actor.getSnapshot();
    if (snapshot.status === "error")
      throw new Fault("workflow", `XState actor failed: ${String(snapshot.error)}`);
    const current = frontier(session.actor);
    graph.atomic(() => {
      const run = workflowRun(graph, id);
      const previous = active(id);
      const keys = new Set(current.map((entry) => entry.key));
      for (const old of previous.toReversed()) {
        if (keys.has(old.key)) continue;
        graph.disconnect(id, old.node.id, workflowRelations.active);
        closeDepartedGroup(old.node.id, session.by);
      }
      const retained = new Map(
        previous.filter((visit) => keys.has(visit.key)).map((visit) => [visit.key, visit]),
      );
      const published = new Map<string, Node>();
      const history = memberNodes(id);
      for (const entry of current) {
        const existing = retained.get(entry.key);
        if (existing !== undefined) {
          published.set(entry.key, existing.node);
          continue;
        }
        const parent = nearestGroup(run, entry, current, published, retained);
        const node = enter(run, parent, entry, history, session.by);
        published.set(entry.key, node);
        history.push(node);
      }
      graph.setAttributes(id, {
        [workflowAttributes.snapshot]: JSON.stringify(session.actor.getPersistedSnapshot()),
        [workflowAttributes.value]: serialise(snapshot.value),
        [workflowAttributes.invocations]: invocations(session.actor),
        [workflowAttributes.checkpointBy]: session.by,
      });
      if (snapshot.status === "done") {
        graph.update(id, { state: "closed" });
        closeDepartedGroup(runContext(run), session.by);
        graph.afterCommit(() => {
          stopActor(session);
          live.delete(id);
        });
      }
    }, authority);
  }

  function fail(id: string, session: LiveRun | undefined, error: unknown): void {
    if (session !== undefined) stopActor(session);
    live.delete(id);
    graph.atomic(
      () =>
        graph.setAttributes(id, {
          [workflowAttributes.error]: error instanceof Error ? error.message : String(error),
          [workflowAttributes.invocations]: [],
        }),
      authority,
    );
  }

  function stopActor(session: LiveRun): void {
    session.status = "stopped";
    session.observer.unsubscribe();
    session.actor.stop();
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

  function enter(run: Node, parent: string, entry: Entry, history: Node[], by: string): Node {
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
          by,
        })
      : work.create({
          kind: "group",
          title: meta.title,
          description: meta.instructions,
          parent,
          by,
        });
    graph.atomic(() => {
      graph.setAttributes(item.id, {
        [workflowAttributes.visit]: true,
        [worker ? workflowAttributes.task : workflowAttributes.group]: true,
        [workflowAttributes.state]: entry.node,
        [workflowAttributes.key]: entry.key,
        [workflowAttributes.path]: entry.path,
        [workflowAttributes.number]: number,
        [workflowAttributes.order]: history.length + 1,
        [workflowAttributes.context]: serialise(entry.context),
        [workflowAttributes.meta]: serialise(meta),
      });
      graph.connect(run.id, item.id, workflowRelations.member);
      graph.connect(run.id, item.id, workflowRelations.active);
    }, authority);
    return graph.show(item.id);
  }

  function closeDepartedGroup(id: string, by: string): void {
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
      context: contextSchema.parse(node.attributes[workflowAttributes.context]),
      meta: resolvedTaskSchema.parse(node.attributes[workflowAttributes.meta]),
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
      actionPending: graph
        .edges(node.id, workflowRelations.active)
        .some((edge) => edge.to_id === node.id),
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
      state: run.attributes[workflowAttributes.value],
      error: run.attributes[workflowAttributes.error] ?? null,
      status:
        run.attributes[workflowAttributes.error] !== undefined
          ? "failed"
          : run.state === "closed"
            ? "complete"
            : activeTasks.length === 0
              ? "waiting"
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
    const visits = active(id);
    const tasks = visits
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
      invocations: run.attributes[workflowAttributes.invocations],
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
      workflowLocatorSchema.parse(run.attributes[workflowAttributes.definition]),
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
      const hot = graph.show(after.id, { includeArchived: false });
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
        throw new Fault("workflow", "Consumed workflow worker visits cannot be reopened");
    }
  });
}

function assertRunning(run: Node): void {
  if (run.attributes[workflowAttributes.error] !== undefined)
    throw new Fault(
      "workflow",
      `Workflow failed: ${text.parse(run.attributes[workflowAttributes.error])}`,
    );
  if (run.state !== "active")
    throw new Fault("workflow", "Workflow is complete; start a fresh run for new work");
}

function runContext(run: Node): string {
  return text.parse(run.attributes[workflowAttributes.contextGroup]);
}

function savedResult(node: Node) {
  return workflowResultSchema.parse(node.attributes[workflowAttributes.result]);
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
  return {
    bead: visit.node.id,
    context: visit.context,
    meta: resolvedTaskSchema.parse(visit.meta),
  };
}

function validateResult(
  definition: Definition,
  visit: Visit,
  choice: string,
  data: unknown,
): unknown {
  const meta = resolvedTaskSchema.parse(visit.meta);
  if (meta.commands?.[choice] === undefined)
    throw new Fault("workflow", `Choice ${choice} is unavailable for ${visit.node.id}`, {
      choices: Object.keys(meta.commands ?? {}),
    });
  const parsed = parseInput(commandSchema(definition, choice), data);
  definition.validateCommand?.(taskEntry(visit), choice, parsed);
  return parsed;
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
