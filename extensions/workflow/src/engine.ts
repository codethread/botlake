import {
  canonical,
  Fault,
  jsonSchema,
  nodeSchema,
  q,
  requireValue,
  type Context,
  type Graph,
  type Json,
  type Mutation,
  type Node,
} from "@botlake/core";
import { attribute, attribution, callerActor } from "@botlake/extension-identity";
import { z } from "zod";

import { workflowBlockages } from "./blockages.ts";
import { locatorSchema, type Catalogue, type Selection } from "./catalogue.ts";
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

const text = z.string().min(1);
const deletedSchema = z.object({
  node: nodeSchema,
  edges: z.array(z.object({ from_id: text, to_id: text, relation: text })),
});
const contextSchema = z.record(z.string(), z.unknown());
const briefSchema = z.object({
  title: text,
  description: z.string(),
  acceptanceCriteria: z.string().optional(),
});
const resultSchema = z.object({ choice: text, data: jsonSchema });
const snapshotSchema = z.custom<ReturnType<typeof snapshotFor>>(
  (value) =>
    z
      .object({
        status: z.string(),
        value: jsonSchema,
        context: jsonSchema,
        children: z.record(z.string(), jsonSchema),
      })
      .safeParse(value).success,
);

interface Visit {
  /** Graph node representing this state-node visit. */
  node: Node;
  /** Actor route plus XState state-node identity, as in Busybee. */
  key: string;
  /** Route to the machine actor receiving this visit's chosen event. */
  path: string[];
  /** Context frozen when the visit was published. */
  context: Record<string, unknown>;
  /** Rendered state metadata, frozen for this visit. */
  meta: z.infer<typeof resolvedTaskSchema>;
}
interface Submission {
  /** Completed graph visit whose original result is being consumed. */
  visit: Visit;
  /** Author-named outcome, mapped to an XState event by the visit. */
  choice: string;
  /** Schema-parsed original outcome data. */
  data: unknown;
}

export function workflowRun(graph: Graph, id: string): Node {
  const node = graph.show(id);
  if (node.attributes["workflow/root"] !== true)
    throw new Fault("workflow", `Expected a workflow run: ${id}`);
  return node;
}

/** Busybee's restore/submit/frontier/publication lifecycle, bound to one graph transaction. */
export function workflowService(ctx: Context, catalogue: Catalogue) {
  const graph = ctx.graph;
  const authority = Symbol("workflow");
  const blockages = workflowBlockages(ctx);
  for (const marker of [
    "workflow/root",
    "workflow/visit",
    "workflow/task",
    "workflow/group",
    "workflow/claim",
  ])
    graph.declareImmutable(marker);
  protectWork();

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
      if (parent !== undefined && graph.show(parent).state !== "active")
        throw new Fault("workflow", "Workflow parent must be active");
      const actor = initialActor(loaded.definition, parsed);
      try {
        const run = graph.add({
          title: brief.title,
          attributes: {
            "workflow/root": true,
            "workflow/definition": JSON.stringify(loaded.locator),
            "workflow/body": brief.description,
            "workflow/acceptance": brief.acceptanceCriteria ?? null,
          },
        });
        if (parent !== undefined) graph.connect(parent, run.id, "parent-of");
        publish(run, actor, []);
        return view(run.id);
      } finally {
        actor.stop();
      }
    }, authority);
  }

  async function show(id: string): Promise<Json> {
    const node = graph.show(id);
    const run = containingRun(id);
    if (node.id === run.id) return view(run.id);
    if (node.attributes["workflow/task"] !== true)
      throw new Fault("workflow", "Show a workflow run or worker task");
    const loaded = await loadRun(run);
    const visit = visitFor(node);
    const { commands, ...metadata } = visit.meta;
    return serialise({
      run: runSummary(run),
      tasks: [
        {
          ...loaded.definition.describe?.(taskEntry(visit)),
          ...metadata,
          ...taskSummary(node),
          instructions: visit.meta.instructions,
          stateNode: node.attributes["workflow/state"],
          visit: node.attributes["workflow/number"],
          context: visit.context,
          choices: Object.fromEntries(
            Object.keys(commands ?? {}).map((choice) => [
              choice,
              { schema: z.toJSONSchema(commandSchema(loaded.definition, choice), { io: "input" }) },
            ]),
          ),
          result: node.state === "closed" ? savedResult(node) : null,
          completedBy: node.attributes["workflow/completed-by"] ?? null,
          assignments: claims(node.id).map((record) => ({
            id: record.id,
            assignee: attribution(graph, text.parse(record.attributes["workflow/owner"])),
            claimedAt: record.attributes["workflow/claimed-at"],
          })),
          blockers: prerequisites(node.id).map((dependency) => ({
            id: dependency.id,
            title: dependency.title,
          })),
          blockages: blockages.effective(node.id, true),
          blockageHistory: blockages.history(node.id),
        },
      ],
    });
  }

  async function complete(task: string, choice: string, data: Json): Promise<Json> {
    const run = containingRun(task);
    const node = graph.show(task);
    if (node.attributes["workflow/task"] !== true)
      throw new Fault("workflow", "Complete a worker task; groups and runs close automatically");
    if (node.attributes["workflow/consumed"] === true) {
      assertMatchingResult(node, choice, data);
      return view(run.id);
    }
    const loaded = await loadRun(run);
    return graph.atomic(() => {
      const current = graph.show(task);
      if (current.attributes["workflow/consumed"] === true) {
        assertMatchingResult(current, choice, data);
        return view(run.id);
      }
      assertRunning(graph.show(run.id));
      assertReady(task);
      const previous = active(run.id);
      const visit = requireValue(
        previous.find((entry) => entry.node.id === task),
        "No current worker visit",
      );
      const parsed = validateResult(loaded.definition, visit, choice, data);
      const completedBy = attribution(
        graph,
        requireValue(callerActor(ctx), "Supply BL_ACTOR to attribute completion"),
      );
      const actor = restore(run.id, loaded.definition);
      try {
        advance(actor, { visit, choice, data: parsed });
        const sequence =
          graph
            .subgraph(run.id)
            .nodes.filter((item) => item.attributes["workflow/consumed"] === true).length + 1;
        graph.update(task, {
          state: "closed",
          attributes: {
            "workflow/result": JSON.stringify({ choice, data }),
            "workflow/consumed": true,
            "workflow/completion-order": sequence,
            "workflow/assignee": assignee(node),
            "workflow/completed-by": completedBy,
          },
        });
        attribute(ctx, task, completedBy.identity, "attributed");
        graph.disconnect(run.id, task, "workflow-active");
        publish(
          run,
          actor,
          previous.filter((entry) => entry.node.id !== task),
        );
        return view(run.id);
      } finally {
        actor.stop();
      }
    }, authority);
  }

  function claim(id: string, owner?: string): Json {
    return graph.atomic(() => {
      const task = graph.show(id);
      if (task.attributes["workflow/task"] !== true || task.state !== "active")
        throw new Fault("workflow", "Claim an active workflow worker task");
      assertRunning(containingRun(id));
      assertReady(id);
      const identity = requireValue(owner ?? callerActor(ctx), "Supply --owner or BL_ACTOR");
      const previous = claims(id);
      const latest = previous.at(-1);
      if (latest?.attributes["workflow/owner"] === identity)
        return serialise({ id, assignee: attribution(graph, identity), claimId: latest.id });
      const record = graph.add({
        title: `Claim ${id}`,
        state: "closed",
        attributes: {
          "workflow/claim": true,
          "workflow/owner": identity,
          "workflow/claimed-at": new Date(ctx.clock.now()).toISOString(),
          "workflow/claim-order": previous.length + 1,
        },
      });
      graph.connect(record.id, id, "claims");
      attribute(ctx, record.id, identity, "claimed");
      return serialise({ id, assignee: attribution(graph, identity), claimId: record.id });
    }, authority);
  }

  return {
    catalog,
    start,
    show,
    complete,
    claim,
    block: (id: string, reason: string, neededFrom?: string, byIdentity?: string) =>
      blockages.block(id, reason, neededFrom, byIdentity),
    unblock: (id: string, resolution: string, byIdentity?: string) =>
      blockages.unblock(id, resolution, byIdentity),
  };

  // -- Busybee publication, with graph-owned identity and history instead of checkpoint inventories --

  function publish(run: Node, actor: WorkflowActor, previous: Visit[]): void {
    const current = frontier(actor);
    const keys = new Set(current.map((entry) => entry.key));
    // Busybee closes departed commandless groups in reverse publication order.
    for (const old of previous.toReversed()) {
      if (keys.has(old.key)) continue;
      if (old.meta.commands !== undefined)
        throw new Fault(
          "workflow",
          "Transition would discard unconsumed work; use branch-scoped events",
          { task: old.node.id },
        );
      graph.update(old.node.id, { state: "closed" });
      graph.disconnect(run.id, old.node.id, "workflow-active");
    }
    const retained = new Map(previous.map((visit) => [visit.key, visit]));
    const published = new Map<string, Node>();
    const history = graph
      .subgraph(run.id)
      .nodes.filter((node) => node.attributes["workflow/visit"] === true);
    for (const entry of current) {
      const existing = retained.get(entry.key);
      if (existing !== undefined) {
        published.set(entry.key, existing.node);
        continue;
      }
      const parent =
        entry.parent === undefined
          ? run
          : requireValue(
              published.get(entry.parent),
              `Missing published state parent ${entry.parent}`,
            );
      if (graph.show(parent.id).state !== "active")
        throw new Fault(
          "workflow",
          "Cannot publish work beneath a closed worker; use a commandless grouping state",
          { parent: parent.id },
        );
      const node = enter(run, parent, entry, history);
      published.set(entry.key, node);
      history.push(node);
    }
    const snapshot = snapshotFor(actor);
    graph.update(run.id, { attributes: { "workflow/snapshot": JSON.stringify(snapshot) } });
    if (currentStatus(actor) === "done") graph.update(run.id, { state: "closed" });
  }

  function enter(run: Node, parent: Node, entry: Entry, history: Node[]): Node {
    const meta = renderTask(entry.meta, entry.context);
    const worker = meta.commands !== undefined;
    const number =
      history.filter((node) => node.attributes["workflow/key"] === entry.key).length + 1;
    const node = graph.add({
      title: meta.title,
      attributes: {
        "workflow/visit": true,
        [worker ? "workflow/task" : "workflow/group"]: true,
        "workflow/state": entry.node,
        "workflow/key": entry.key,
        "workflow/path": entry.path,
        "workflow/number": number,
        "workflow/order": history.length + 1,
        "workflow/context": JSON.stringify(entry.context),
        "workflow/meta": JSON.stringify(meta),
      },
    });
    graph.connect(parent.id, node.id, "parent-of");
    graph.connect(parent.id, node.id, "depends-on");
    graph.connect(run.id, node.id, "workflow-active");
    return node;
  }

  function active(id: string): Visit[] {
    return graph
      .edges(id, "workflow-active")
      .filter((edge) => edge.from_id === id)
      .map((edge) => graph.show(edge.to_id))
      .toSorted(
        (a, b) =>
          z.number().parse(a.attributes["workflow/order"]) -
          z.number().parse(b.attributes["workflow/order"]),
      )
      .map((node) => visitFor(node));
  }

  function visitFor(node: Node): Visit {
    return {
      node,
      key: text.parse(node.attributes["workflow/key"]),
      path: z.array(z.string()).parse(node.attributes["workflow/path"]),
      context: contextSchema.parse(JSON.parse(text.parse(node.attributes["workflow/context"]))),
      meta: resolvedTaskSchema.parse(JSON.parse(text.parse(node.attributes["workflow/meta"]))),
    };
  }

  function claims(id: string): Node[] {
    return graph
      .edges(id, "claims")
      .filter((edge) => edge.to_id === id)
      .map((edge) => graph.show(edge.from_id))
      .filter((node) => node.attributes["workflow/claim"] === true)
      .toSorted(
        (a, b) =>
          z.number().parse(a.attributes["workflow/claim-order"]) -
          z.number().parse(b.attributes["workflow/claim-order"]),
      );
  }

  function assignee(node: Node): Json {
    if (node.state === "closed")
      return jsonSchema.parse(node.attributes["workflow/assignee"] ?? null);
    const latest = claims(node.id).at(-1);
    return latest === undefined
      ? null
      : attribution(graph, text.parse(latest.attributes["workflow/owner"]));
  }

  function prerequisites(id: string): Node[] {
    return graph
      .edges(id, "depends-on")
      .filter((edge) => edge.from_id === id)
      .map((edge) => graph.show(edge.to_id))
      .filter((node) => node.state === "active");
  }

  function taskSummary(node: Node) {
    const holds = blockages.effective(node.id);
    const pending = prerequisites(node.id);
    return {
      id: node.id,
      title: node.title,
      status:
        node.state === "closed"
          ? "done"
          : holds.length > 0 || pending.length > 0
            ? "blocked"
            : "ready",
      assignee: assignee(node),
      blockages: holds,
      blockers: pending.map((dependency) => ({ id: dependency.id, title: dependency.title })),
    };
  }

  function runSummary(run: Node) {
    const workers = graph
      .subgraph(run.id)
      .nodes.filter((node) => node.attributes["workflow/task"] === true && node.state === "active");
    const ordinary = graph
      .subgraph(run.id)
      .nodes.filter(
        (node) =>
          node.id !== run.id &&
          node.state === "active" &&
          node.attributes["workflow/visit"] !== true,
      );
    const actionable = [...workers, ...ordinary].some(
      (node) => blockages.effective(node.id).length === 0 && prerequisites(node.id).length === 0,
    );
    return {
      id: run.id,
      title: run.title,
      status: run.state === "closed" ? "complete" : actionable ? "active" : "blocked",
      blockages: blockages.effective(run.id),
    };
  }

  function view(id: string): Json {
    const run = workflowRun(graph, id);
    const nodes = graph.subgraph(id).nodes;
    return serialise({
      run: runSummary(run),
      tasks: nodes
        .filter((node) => node.state === "active" && node.attributes["workflow/task"] === true)
        .map((node) => taskSummary(node)),
      history: nodes
        .filter((node) => node.attributes["workflow/consumed"] === true)
        .toSorted(
          (a, b) =>
            z.number().parse(a.attributes["workflow/completion-order"]) -
            z.number().parse(b.attributes["workflow/completion-order"]),
        )
        .map((node) => ({
          id: node.id,
          title: node.title,
          choice: savedResult(node).choice,
          assignee: assignee(node),
        })),
    });
  }

  async function loadRun(run: Node) {
    return catalogue.restore(
      locatorSchema.parse(JSON.parse(text.parse(run.attributes["workflow/definition"]))),
    );
  }

  function restore(id: string, definition: Definition): WorkflowActor {
    const run = workflowRun(graph, id);
    return restoredActor(
      definition,
      snapshotSchema.parse(JSON.parse(text.parse(run.attributes["workflow/snapshot"]))),
    );
  }

  function containingRun(id: string): Node {
    let node = graph.show(id);
    while (node.attributes["workflow/root"] !== true) {
      if (node.attributes["workflow/visit"] !== true && node.attributes["workflow/task"] !== true)
        throw new Fault("workflow", `Expected workflow work: ${node.id}`);
      const childId = node.id;
      const parents = graph.edges(childId, "parent-of").filter((edge) => edge.to_id === childId);
      if (parents.length !== 1)
        throw new Fault("workflow", `Expected one workflow parent: ${childId}`);
      node = graph.show(requireValue(parents[0], "Missing workflow parent").from_id);
    }
    return node;
  }

  function assertReady(id: string): void {
    blockages.assertUnblocked(id);
    if (graph.all({ ready: true, where: q.eq("id", id) }).length === 0)
      throw new Fault("workflow", "Finish graph prerequisites before completing this task", {
        blockers: prerequisites(id).map((node) => node.id),
      });
  }

  function assertRunning(run: Node): void {
    if (run.state !== "active")
      throw new Fault("workflow", "Workflow is complete; start a fresh run for new work");
    blockages.assertUnblocked(run.id);
  }

  function deletedWork(id: string) {
    const row = graph.tombstones(id).at(-1);
    if (row === undefined) return;
    const saved = z.object({ snapshot: text }).parse(row);
    return deletedSchema.parse(JSON.parse(saved.snapshot));
  }

  function withinRun(id: string, changes: readonly Mutation[] = []): boolean {
    const pending = [id];
    const seen = new Set<string>();
    while (pending.length > 0) {
      const current = pending.pop();
      if (current === undefined || seen.has(current)) continue;
      seen.add(current);
      const node = graph.all({ where: q.eq("id", current), lean: false })[0];
      const deleted = node === undefined ? deletedWork(current) : undefined;
      if (deleted?.node.attributes["workflow/root"] === true) return true;
      for (const edge of deleted?.edges ?? [])
        if (edge.relation === "parent-of" && edge.to_id === current) pending.push(edge.from_id);
      if (
        node?.attributes["workflow/root"] === true ||
        changes.some(
          (change) =>
            change.kind === "node" &&
            change.before?.id === current &&
            change.before.attributes["workflow/root"] === true,
        )
      )
        return true;
      for (const edge of graph.edges(current, "parent-of"))
        if (edge.to_id === current) pending.push(edge.from_id);
      for (const change of changes)
        if (
          change.kind === "edge" &&
          change.before?.relation === "parent-of" &&
          change.before.to_id === current
        )
          pending.push(change.before.from_id);
    }
    return false;
  }

  function assertOpenParents(id: string): void {
    const pending = graph
      .edges(id, "parent-of")
      .filter((edge) => edge.to_id === id)
      .map((edge) => edge.from_id);
    const seen = new Set<string>();
    while (pending.length > 0) {
      const current = pending.pop();
      if (current === undefined || seen.has(current)) continue;
      seen.add(current);
      const parent = graph.show(current);
      if (parent.state !== "active")
        throw new Fault("workflow", "New or reopened work requires active containing work");
      if (parent.attributes["workflow/root"] === true) continue;
      for (const edge of graph.edges(current, "parent-of"))
        if (edge.to_id === current) pending.push(edge.from_id);
    }
  }

  function protectWork(): void {
    graph.protect((changes, token) => {
      for (const change of changes) {
        if (change.kind === "edge") {
          const edge = change.before ?? change.after;
          if (edge === null || token === authority) continue;
          const from = graph.all({ where: q.eq("id", edge.from_id), lean: false })[0];
          const to = graph.all({ where: q.eq("id", edge.to_id), lean: false })[0];
          if (
            edge.relation.startsWith("workflow-") ||
            from?.attributes["workflow/claim"] === true ||
            (edge.relation === "claims" && to?.attributes["workflow/task"] === true)
          )
            throw new Fault("workflow", "Workflow records require workflow commands");
          if (edge.relation !== "parent-of" && edge.relation !== "depends-on") continue;
          if (
            edge.relation === "parent-of" &&
            change.after === null &&
            to?.attributes["workflow/root"] === true &&
            graph.edge(edge.from_id, edge.to_id, edge.relation) === null
          )
            throw new Fault("workflow", "Workflow root links are retained completion contracts");
          if (
            to?.attributes["workflow/visit"] === true ||
            (from?.attributes["workflow/visit"] === true &&
              to?.attributes["workflow/root"] === true)
          )
            throw new Fault("workflow", "State visit links require workflow commands");
          if (
            edge.relation === "parent-of" &&
            managed(from) &&
            change.after !== null &&
            from?.state !== "active"
          )
            throw new Fault("workflow", "New work requires an active parent");
          if (
            edge.relation === "parent-of" &&
            change.after === null &&
            withinRun(edge.from_id, changes) &&
            (to === undefined
              ? deletedWork(edge.to_id)?.node.state !== "closed"
              : graph.subgraph(to.id).nodes.some((node) => node.state !== "closed"))
          )
            throw new Fault("workflow", "Finish contained work before removing it");
          if (
            edge.relation === "parent-of" &&
            change.after !== null &&
            to !== undefined &&
            withinRun(edge.to_id)
          )
            for (const node of graph
              .subgraph(to.id)
              .nodes.filter((candidate) => candidate.state === "active"))
              assertOpenParents(node.id);
          continue;
        }
        const { before, after } = change;
        const keys = new Set([
          ...Object.keys(before?.attributes ?? {}),
          ...Object.keys(after?.attributes ?? {}),
        ]);
        const hot = after === null ? null : graph.show(after.id, true);
        for (const key of keys) {
          if (!key.startsWith("workflow/")) continue;
          if (after?.attributes[key] !== undefined && hot?.attributes[key] === undefined)
            throw new Fault("workflow", "Workflow evidence cannot be archived");
          if (
            token !== authority &&
            canonical(before?.attributes[key] ?? null) !== canonical(after?.attributes[key] ?? null)
          )
            throw new Fault("workflow", "Workflow records require workflow commands");
        }
        if (
          before?.attributes["workflow/claim"] === true &&
          canonical(serialise(before)) !== canonical(serialise(after))
        )
          throw new Fault("workflow", "Ownership claims are immutable");
        if (after === null) {
          if (managed(before)) throw new Fault("workflow", "Workflow records are retained history");
          continue;
        }
        if (after.state === "active") {
          const dependents = graph
            .edges(after.id, "depends-on")
            .filter((edge) => edge.to_id === after.id)
            .map((edge) => graph.show(edge.from_id))
            .filter((node) => node.attributes["workflow/task"] === true && node.state === "closed");
          if (dependents.length > 0)
            throw new Fault("workflow", "Completed work cannot acquire unresolved prerequisites");
        }
        if (before?.state === "active" && after.state !== "active")
          blockages.assertUnblocked(after.id);
        if (after.state === "active" && before?.state !== "active" && withinRun(after.id))
          assertOpenParents(after.id);
        if (!managed(after)) continue;
        if (after.state === "replaced")
          throw new Fault("workflow", "Workflow records cannot be replaced");
        if (
          before !== null &&
          token !== authority &&
          (before.state !== after.state || before.title !== after.title)
        )
          throw new Fault(
            "workflow",
            "Use workflow commands to change work state or authored title",
          );
        if (after.state === "closed" && after.attributes["workflow/claim"] !== true) {
          const pending = graph
            .subgraph(after.id)
            .nodes.filter((node) => node.id !== after.id && node.state !== "closed");
          if (pending.length > 0)
            throw new Fault("workflow", "Finish contained work first", {
              pending: pending.map((node) => node.id),
            });
          if (prerequisites(after.id).length > 0)
            throw new Fault("workflow", "Resolve dependencies before finishing");
        }
        if (after.state === "active" && after.attributes["workflow/visit"] === true) {
          if (after.attributes["workflow/consumed"] === true)
            throw new Fault("workflow", "Consumed visits stay closed");
          const parents = graph
            .edges(after.id, "parent-of")
            .filter((edge) => edge.to_id === after.id)
            .map((edge) => graph.show(edge.from_id));
          if (parents.some((parent) => parent.state !== "active"))
            throw new Fault("workflow", "Reopen the containing work first");
        }
      }
    });
  }
}

// -- Definition contracts and event delivery, following Busybee's submissionTarget/advance --

function savedResult(node: Node) {
  return resultSchema.parse(JSON.parse(text.parse(node.attributes["workflow/result"])));
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

function managed(node: Node | null | undefined): boolean {
  return (
    node !== undefined &&
    node !== null &&
    ["workflow/root", "workflow/visit", "workflow/task", "workflow/claim"].some(
      (marker) => node.attributes[marker] === true,
    )
  );
}

function serialise(value: unknown): Json {
  return jsonSchema.parse(JSON.parse(JSON.stringify(value)));
}
