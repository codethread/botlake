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
import {
  workStore,
  workNamespace,
  gateService,
  type ProbeDefinition,
  type GateStatus,
  type Page,
  type WorkStore,
  type WorkSummary,
} from "@botlake/extension-work";
import { match } from "ts-pattern";
import { z } from "zod";

import { type Catalogue, type Selection } from "./catalogue.ts";
import {
  currentStatus,
  initialActor,
  renderVisit,
  resolvedGateSchema,
  resolvedTaskSchema,
  restoredActor,
  snapshotFor,
  targetActor,
  type Definition,
  type GateEventData,
  type ResolvedVisit,
  type WorkflowActor,
} from "./definition.ts";
import { frontier } from "./frontier.ts";
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
const publicationEntrySchema = z.object({
  identity: text,
  key: text,
  parent: text.optional(),
  path: z.array(z.string()),
  node: text,
  context: contextSchema,
  meta: z.union([resolvedGateSchema, resolvedTaskSchema]),
});
const publicationSchema = z.object({ entries: z.array(publicationEntrySchema), done: z.boolean() });
type PublicationEntry = z.infer<typeof publicationEntrySchema>;
type PreparedGate = Awaited<ReturnType<ReturnType<typeof gateService>["prepare"]>>;

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
  identity: string;
  path: string[];
  context: Record<string, unknown>;
  meta: ResolvedVisit;
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

/** Checkpoints authored execution and reconciles its frozen frontier into Work. */
export function workflowService(ctx: Context, catalogue: Catalogue) {
  const graph = ctx.graph;
  const work = workStore(ctx);
  const authority = Symbol("workflow");
  const queues = new Map<string, Promise<void>>();
  for (const marker of [
    workflowAttributes.root,
    workflowAttributes.visit,
    workflowAttributes.task,
    workflowAttributes.group,
    workflowAttributes.gate,
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
      const actor = initialActor(loaded.definition, parsed);
      try {
        const publication = plan(actor, []);
        const context = work.create({
          kind: "group",
          title: brief.title,
          description: brief.description,
          parent,
          by: actorName,
        });
        const run = graph.add({
          title: `Workflow execution ${context.id}`,
          attributes: {
            [workflowAttributes.root]: true,
            [workflowAttributes.private]: true,
            [workflowAttributes.contextGroup]: context.id,
            [workflowAttributes.definition]: loaded.locator,
          },
        });
        graph.update(run.id, {
          attributes: {
            [workflowAttributes.snapshot]: JSON.stringify(snapshotFor(actor)),
            [workflowAttributes.checkpointBy]: actorName,
            [workflowAttributes.publication]: serialise(publication),
          },
        });
        return run.id;
      } finally {
        actor.stop();
      }
    }, authority);
    return inRun(runId, async () => {
      await reconcile(runId);
      return view(runId);
    });
  }

  async function showUnlocked(
    id: string,
    options: { limit?: number; offset?: number; historyOffset?: number } = {},
  ): Promise<Json> {
    const run =
      graph.show(id).attributes[workflowAttributes.root] === true
        ? workflowRun(graph, id)
        : containingRun(id);
    await reconcile(run.id);
    if (id === run.id) return view(run.id, showOptionsSchema.parse(options));
    const node = graph.show(id);
    if (
      node.attributes[workflowAttributes.task] !== true &&
      node.attributes[workflowAttributes.gate] !== true
    )
      throw new Fault("workflow", "Show a workflow run, worker task or gate visit");
    const visit = visitFor(node);
    if (isGateVisit(visit)) {
      const gate = work.gates.get(node.id);
      return serialise({
        run: runSummary(run),
        gates: [
          {
            id: gate.id,
            title: gate.title,
            status: gate.status,
            stateNode: node.attributes[workflowAttributes.state],
            visit: node.attributes[workflowAttributes.number],
          },
        ],
      });
    }
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

  async function completeUnlocked(
    taskId: string,
    choice: string,
    data: Json,
    callerIdentity: string | null,
  ): Promise<Json> {
    const run = containingRun(taskId);
    await reconcile(run.id);
    const node = graph.show(taskId);
    if (node.attributes[workflowAttributes.task] !== true)
      throw new Fault("workflow", "Complete a workflow worker task");
    if (node.attributes[workflowAttributes.consumed] === true) {
      assertMatchingResult(node, choice, data);
      return view(run.id);
    }
    const loaded = await loadRun(run);
    graph.atomic(() => {
      assertRunning(graph.show(run.id));
      assertDirectPrerequisitesClosed(work, taskId);
      const previous = active(run.id);
      const visit = requireValue(
        previous.find((entry) => entry.node.id === taskId),
        "No current worker visit",
      );
      const parsed = validateResult(loaded.definition, visit, choice, data);
      const actorName = requireValue(
        callerIdentity,
        "Supply caller identity to attribute completion",
      );
      const actor = restore(run.id, loaded.definition);
      try {
        advance(actor, { visit, choice, data: parsed });
        const sequence =
          memberNodes(run.id).filter(
            (item) => item.attributes[workflowAttributes.consumed] === true,
          ).length + 1;
        if (work.get(taskId).state === "open") work.close(taskId, actorName);
        const publication = plan(
          actor,
          previous.filter((entry) => entry.node.id !== taskId),
        );
        graph.setAttributes(taskId, {
          [workflowAttributes.result]: { choice, data },
          [workflowAttributes.consumed]: true,
          [workflowAttributes.completionOrder]: sequence,
          [workflowAttributes.completedBy]: actorName,
        });
        graph.disconnect(run.id, taskId, workflowRelations.active);
        graph.update(run.id, {
          attributes: {
            [workflowAttributes.snapshot]: JSON.stringify(snapshotFor(actor)),
            [workflowAttributes.checkpointBy]: actorName,
            [workflowAttributes.publication]: serialise(publication),
          },
        });
      } finally {
        actor.stop();
      }
    }, authority);
    await reconcile(run.id);
    return view(run.id);
  }

  async function reactToGateUnlocked(id: string, status?: GateStatus): Promise<void> {
    const run = containingRun(id);
    await reconcile(run.id);
    await checkpointGate(id, status);
    await reconcile(run.id);
  }

  async function checkpointGate(id: string, status?: GateStatus): Promise<boolean> {
    const run = containingRun(id);
    const loaded = await loadRun(run);
    return graph.atomic(() => {
      const node = graph.show(id);
      const current = work.gates.get(id).status;
      if (status !== undefined && canonical(serialise(status)) !== canonical(serialise(current)))
        return false;
      const visit = visitFor(node);
      if (!isGateVisit(visit)) return false;
      const event = mappedGateEvent(visit, current);
      if (event === undefined || node.attributes[workflowAttributes.consumed] === true)
        return false;
      if (!active(run.id).some((entry) => entry.node.id === id)) return false;
      const by = text.parse(graph.show(run.id).attributes[workflowAttributes.checkpointBy]);
      const actor = restore(run.id, loaded.definition);
      try {
        const data: GateEventData = { gate: id, status: current };
        advanceGate(actor, visit, event, data);
        const publication = plan(
          actor,
          active(run.id).filter((entry) => entry.node.id !== id),
        );
        graph.setAttributes(id, {
          [workflowAttributes.result]: { choice: current.status, data: serialise(data) },
          [workflowAttributes.consumed]: true,
          [workflowAttributes.completionOrder]:
            memberNodes(run.id).filter(
              (item) => item.attributes[workflowAttributes.consumed] === true,
            ).length + 1,
          [workflowAttributes.completedBy]: by,
        });
        graph.disconnect(run.id, id, workflowRelations.active);
        graph.update(run.id, {
          attributes: {
            [workflowAttributes.snapshot]: JSON.stringify(snapshotFor(actor)),
            [workflowAttributes.checkpointBy]: by,
            [workflowAttributes.publication]: serialise(publication),
          },
        });
      } finally {
        actor.stop();
      }
      return true;
    }, authority);
  }

  return { catalog, start, show, complete, reactToGate, reconcile: resume };

  function show(...args: Parameters<typeof showUnlocked>): Promise<Json> {
    const node = graph.show(args[0]);
    const id =
      node.attributes[workflowAttributes.root] === true ? node.id : containingRun(node.id).id;
    return inRun(id, () => showUnlocked(...args));
  }

  function complete(...args: Parameters<typeof completeUnlocked>): Promise<Json> {
    return inRun(containingRun(args[0]).id, () => completeUnlocked(...args));
  }

  async function reactToGate(id: string, status?: GateStatus): Promise<void> {
    if (graph.show(id).attributes[workflowAttributes.gate] !== true) return;
    await inRun(containingRun(id).id, () => reactToGateUnlocked(id, status));
  }

  function resume(id: string): Promise<void> {
    return inRun(id, () => reconcile(id));
  }

  // Async catalogue/probe work must not let another event advance the same checkpoint.
  async function inRun<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = queues.get(id) ?? Promise.resolve();
    const turn = Promise.withResolvers<void>();
    queues.set(id, turn.promise);
    await previous;
    try {
      return await action();
    } finally {
      turn.resolve();
      if (queues.get(id) === turn.promise) queues.delete(id);
    }
  }

  function plan(actor: WorkflowActor, previous: Visit[]) {
    const current = frontier(actor);
    const keys = new Set(current.map((entry) => entry.key));
    for (const old of previous)
      if (!keys.has(old.key) && old.meta.commands !== undefined)
        throw new Fault("workflow", "Transition would discard unconsumed work", {
          task: old.node.id,
        });
    const entries = current.map((entry) => {
      const retained = previous.find((visit) => visit.key === entry.key);
      const meta = retained?.meta ?? renderVisit(entry.meta, entry.context);
      const task = resolvedTaskSchema.safeParse(meta);
      if (task.success) {
        assertTaskAttributes(graph, task.data.attributes ?? {});
        if (
          task.data.commands === undefined &&
          [
            task.data.acceptanceCriteria,
            task.data.assignee,
            task.data.audience,
            task.data.origin,
            task.data.priority,
            task.data.notes,
            task.data.attributes,
          ].some((value) => value !== undefined)
        )
          throw new Fault("workflow", "Commandless context groups cannot declare task fields");
      }
      return {
        ...entry,
        context: retained?.context ?? entry.context,
        meta,
        identity: retained?.identity ?? crypto.randomUUID(),
      };
    });
    return { entries, done: currentStatus(actor) === "done" };
  }

  async function reconcile(id: string): Promise<void> {
    while (true) {
      await publish(id);
      // This caller owns the run queue. Deliver one committed gate internally, then
      // publish its checkpoint before another visit. Scan even without a publication
      // intent so a failed status delivery can be retried by show/complete.
      let advanced = false;
      for (const visit of active(id)) {
        if (!isGateVisit(visit)) continue;
        if (mappedGateEvent(visit, work.gates.get(visit.node.id).status) === undefined) continue;
        try {
          advanced = await checkpointGate(visit.node.id);
        } catch (error) {
          throw new Fault(
            "workflow-publication",
            `Workflow ${id} checkpoint retained; gate ${visit.node.id} status delivery pending: ${error instanceof Error ? error.message : String(error)}`,
            { run: id },
          );
        }
        if (advanced) break;
      }
      if (!advanced) return;
    }
  }

  async function publish(id: string): Promise<void> {
    const run = workflowRun(graph, id);
    const pending = run.attributes[workflowAttributes.publication];
    if (pending === null) return;
    try {
      const publication = publicationSchema.parse(pending);
      const loaded = await loadRun(run);
      const by = text.parse(run.attributes[workflowAttributes.checkpointBy]);
      const previous = active(id);
      const prepared = new Map<string, PreparedGate[]>();
      // Resolve trusted probes before opening a synchronous graph transaction.
      for (const entry of publication.entries) {
        if (previous.some((visit) => visit.identity === entry.identity)) continue;
        const gateVisit = resolvedGateSchema.safeParse(entry.meta);
        const gates = gateVisit.success
          ? [{ title: gateVisit.data.title, ...gateVisit.data.gate }]
          : (resolvedTaskSchema.parse(entry.meta).gates ?? []);
        const creates: PreparedGate[] = [];
        for (const gate of gates)
          creates.push(
            await gateService(ctx).prepare({
              title: gate.title,
              ...(gate.description === undefined ? {} : { description: gate.description }),
              probe: resolveGateProbe(run, loaded.definition.probes, gate.probe),
              params: gate.params,
              by,
            }),
          );
        prepared.set(entry.identity, creates);
      }
      graph.atomic(() => {
        const retained = new Map(active(id).map((visit) => [visit.key, visit]));
        const keys = new Set(publication.entries.map((entry) => entry.key));
        for (const old of [...retained.values()].toReversed()) {
          if (keys.has(old.key)) continue;
          graph.disconnect(id, old.node.id, workflowRelations.active);
          closeDepartedGroup(old.node.id, by);
        }
        const published = new Map<string, Node>();
        const history = memberNodes(id);
        for (const entry of publication.entries) {
          const existing = retained.get(entry.key);
          if (existing?.identity === entry.identity) {
            published.set(entry.key, existing.node);
            continue;
          }
          const parent = nearestGroup(run, entry, publication.entries, published, retained);
          const node = enter(
            run,
            parent,
            entry,
            history,
            by,
            requireValue(prepared.get(entry.identity), "Missing prepared visit"),
          );
          published.set(entry.key, node);
          history.push(node);
        }
        graph.setAttributes(id, { [workflowAttributes.publication]: null });
        if (publication.done) {
          graph.update(id, { state: "closed" });
          closeDepartedGroup(runContext(run), by);
        }
      }, authority);
    } catch (error) {
      throw new Fault(
        "workflow-publication",
        `Workflow ${id} checkpoint retained; publication pending: ${error instanceof Error ? error.message : String(error)}`,
        { run: id },
      );
    }
  }

  function nearestGroup(
    run: Node,
    entry: PublicationEntry,
    current: PublicationEntry[],
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

  function enter(
    run: Node,
    parent: string,
    entry: PublicationEntry,
    history: Node[],
    by: string,
    gates: PreparedGate[],
  ): Node {
    const meta = entry.meta;
    const parsedGate = resolvedGateSchema.safeParse(meta);
    const gateMeta = parsedGate.success ? parsedGate.data : undefined;
    const gateVisit = gateMeta !== undefined;
    const taskMeta = gateVisit ? undefined : resolvedTaskSchema.parse(meta);
    const worker = taskMeta?.commands !== undefined;
    const number =
      Math.max(
        0,
        ...history
          .filter((node) => node.attributes[workflowAttributes.key] === entry.key)
          .map((node) =>
            z.number().int().positive().parse(node.attributes[workflowAttributes.number]),
          ),
      ) + 1;
    const order =
      Math.max(
        0,
        ...history.map((node) =>
          z.number().int().positive().parse(node.attributes[workflowAttributes.order]),
        ),
      ) + 1;
    const reusableGate = gateVisit
      ? history
          .toReversed()
          .find(
            (node) =>
              node.attributes[workflowAttributes.key] === entry.key &&
              node.attributes[workflowAttributes.gate] === true &&
              work.gates.get(node.id).state === "open",
          )
      : undefined;
    if (reusableGate !== undefined) {
      graph.atomic(() => {
        graph.setAttributes(reusableGate.id, {
          [workflowAttributes.consumed]: false,
          [workflowAttributes.identity]: entry.identity,
          [workflowAttributes.number]: number,
          [workflowAttributes.order]: order,
          [workflowAttributes.context]: serialise(entry.context),
          [workflowAttributes.meta]: serialise(meta),
        });
        graph.connect(run.id, reusableGate.id, workflowRelations.active);
      }, authority);
      if (work.gates.get(reusableGate.id).status.status === "exhausted")
        gateService(ctx).retry(reusableGate.id, by, "Workflow gate state re-entered");
      return graph.show(reusableGate.id);
    }

    const item = gateVisit
      ? requireValue(gates[0], "Missing prepared gate")({ parent })
      : worker
        ? work.create({
            kind: "task",
            title: requireValue(taskMeta, "Missing task metadata").title,
            description: requireValue(taskMeta, "Missing task metadata").instructions,
            parent,
            ...taskAuthorship(requireValue(taskMeta, "Missing task metadata")),
            by,
          })
        : work.create({
            kind: "group",
            title: requireValue(taskMeta, "Missing group metadata").title,
            description: requireValue(taskMeta, "Missing group metadata").instructions,
            parent,
            by,
          });
    if (worker) for (const create of gates) create({ parent, dependents: [item.id] });
    graph.atomic(() => {
      graph.setAttributes(item.id, {
        [workflowAttributes.identity]: entry.identity,
        [workflowAttributes.visit]: true,
        [gateVisit
          ? workflowAttributes.gate
          : worker
            ? workflowAttributes.task
            : workflowAttributes.group]: true,
        [workflowAttributes.state]: entry.node,
        [workflowAttributes.key]: entry.key,
        [workflowAttributes.path]: entry.path,
        [workflowAttributes.number]: number,
        [workflowAttributes.order]: order,
        [workflowAttributes.context]: serialise(entry.context),
        [workflowAttributes.meta]: serialise(meta),
      });
      graph.connect(run.id, item.id, workflowRelations.member);
      graph.connect(run.id, item.id, workflowRelations.active);
      if (worker) {
        const attributes = requireValue(taskMeta, "Missing task metadata").attributes ?? {};
        assertTaskAttributes(graph, attributes);
        graph.setAttributes(item.id, attributes);
      }
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
      identity: text.parse(node.attributes[workflowAttributes.identity]),
      path: z.array(z.string()).parse(node.attributes[workflowAttributes.path]),
      context: contextSchema.parse(node.attributes[workflowAttributes.context]),
      meta:
        node.attributes[workflowAttributes.gate] === true
          ? resolvedGateSchema.parse(node.attributes[workflowAttributes.meta])
          : resolvedTaskSchema.parse(node.attributes[workflowAttributes.meta]),
    };
  }

  function taskSummary(node: Node) {
    const summary = work.summary(node.id);
    const gates = work.inspect(node.id, { limit: 100 }).prerequisites.flatMap((prerequisite) => {
      const item = work.get(prerequisite.id);
      return item.kind === "gate" ? [{ id: item.id, title: item.title, status: item.status }] : [];
    });
    return {
      id: summary.id,
      title: summary.title,
      status: summary.state === "closed" ? "done" : summary.ready ? "ready" : "blocked",
      assignee: summary.assignee,
      audience: summary.audience,
      priority: summary.priority,
      actionPending: node.attributes[workflowAttributes.consumed] !== true,
      gates,
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
    const visits = active(id);
    const tasks = visits
      .filter((visit) => visit.node.attributes[workflowAttributes.task] === true)
      .map((visit) => taskSummary(visit.node));
    const gates = visits
      .filter((visit) => visit.node.attributes[workflowAttributes.gate] === true)
      .map((visit) => {
        const gate = work.gates.get(visit.node.id);
        return { id: gate.id, title: gate.title, status: gate.status };
      });
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
      gates: gates.slice(options.offset, options.offset + options.limit),
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

function isGateVisit(visit: Visit): visit is Visit & { meta: z.infer<typeof resolvedGateSchema> } {
  return "gate" in visit.meta;
}

function mappedGateEvent(
  visit: Visit & { meta: z.infer<typeof resolvedGateSchema> },
  status: GateStatus,
) {
  return match(status)
    .with({ status: "pending" }, () => visit.meta.on.pending)
    .with({ status: "waiting" }, () => visit.meta.on.waiting)
    .with({ status: "exhausted" }, () => visit.meta.on.exhausted)
    .with({ status: "cleared" }, () => visit.meta.on.cleared)
    .with({ status: "dismissed" }, () => visit.meta.on.dismissed)
    .exhaustive();
}

function advanceGate(root: WorkflowActor, visit: Visit, type: string, data: GateEventData): void {
  const actor = targetActor(root, visit.path);
  const event = { type, data };
  if (!actor.getSnapshot().can(event))
    throw new Fault("workflow", `Gate status event ${type} is unavailable for ${visit.node.id}`);
  actor.send(event);
  if (root.getSnapshot().status === "error")
    throw new Fault("workflow", `XState transition failed: ${String(root.getSnapshot().error)}`);
}

function resolveGateProbe(run: Node, probes: ProbeDefinition[], key: string): string {
  const locator = workflowLocatorSchema.parse(run.attributes[workflowAttributes.definition]);
  if (locator.kind === "named" && !key.includes("/") && probes.some((probe) => probe.name === key))
    return `${locator.name}/${key}`;
  return key;
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
      if (
        before?.attributes[workflowAttributes.consumed] === true &&
        after.state === "active" &&
        before.attributes[workflowAttributes.gate] !== true
      )
        throw new Fault("workflow", "Consumed workflow worker visits cannot be reopened");
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

function advance(root: WorkflowActor, submission: Submission): void {
  const { actor, type } = submissionTarget(root, submission);
  actor.send({ type, data: submission.data });
  if (root.getSnapshot().status === "error")
    throw new Fault("workflow", `XState transition failed: ${String(root.getSnapshot().error)}`);
}

function submissionTarget(root: WorkflowActor, submission: Submission) {
  const { visit, choice, data } = submission;
  const actor = targetActor(root, visit.path);
  const meta = resolvedTaskSchema.parse(visit.meta);
  const type = requireValue(
    meta.commands?.[choice],
    `Choice ${choice} is unavailable for ${visit.node.id}`,
  );
  if (!actor.getSnapshot().can({ type, data }))
    throw new Fault("workflow", `Choice ${choice} is unavailable for ${visit.node.id}`, {
      choices: Object.keys(meta.commands ?? {}),
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

function assertTaskAttributes(graph: Graph, attributes: Record<string, Json>): void {
  for (const key of Object.keys(attributes))
    if (
      key.startsWith(workNamespace) ||
      key.startsWith(workflowNamespace) ||
      graph.isImmutable(key)
    )
      throw new Fault("workflow", `Task attributes cannot overwrite owned facts: ${key}`);
}
