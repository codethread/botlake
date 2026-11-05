import { getStateNodes } from "xstate";

import {
  actorContext,
  childActors,
  isWorkflowActor,
  metadataSchema,
  type Metadata,
  type WorkflowActor,
  type WorkflowNode,
} from "./definition.ts";

export interface Entry {
  /** Stable actor-path and state-node identity for an active visit. */
  key: string;
  /** Nearest titled state or child actor group key. */
  parent?: string;
  /** Child actor route from the root actor. */
  path: string[];
  /** Full XState state node ID. */
  node: string;
  /** Serializable task-facing context at publication. */
  context: Record<string, unknown>;
  /** Author metadata before its visit renderer runs. */
  meta: Metadata;
}

/** Project only metadata-labelled machine states; execution actors stay inside XState. */
export function frontier(
  actor: WorkflowActor,
  path: string[] = [],
  inheritedParent?: string,
): Entry[] {
  const snapshot = actor.getSnapshot();
  if (snapshot.status !== "active") return [];
  const context = actorContext(actor);
  // AnyStateMachine erases the state-value type, but XState supplies it here.
  // oxlint-disable-next-line typescript/no-unsafe-argument
  const nodes = [...new Set(getStateNodes(snapshot.machine.root, snapshot.value))];
  const entries = workNodes(nodes).map((node) =>
    nodeEntry(node, { context, inheritedParent, path }),
  );
  for (const child of childActors(actor)) {
    if (!isWorkflowActor(child)) continue;
    const invoking = nodes.find((node) => node.invoke.some((invoke) => invoke.id === child.id));
    const group = invoking === undefined ? undefined : titledNode(invoking);
    const parent = group === undefined ? inheritedParent : stateKey(path, group);
    entries.push(...frontier(child, [...path, child.id], parent));
  }
  return entries;
}

// --- Private projection helpers ---

function workNodes(nodes: WorkflowNode[]): WorkflowNode[] {
  const completedParents = new Set(
    nodes.filter((node) => node.type === "final").map((node) => node.parent),
  );
  return nodes.filter((node) => {
    // Dynamic XState node metadata is intentionally parsed only after frontier selection.
    // oxlint-disable-next-line typescript/no-unsafe-member-access
    const title: unknown = node.meta?.["title"];
    return node.type !== "final" && title !== undefined && !completedParents.has(node);
  });
}

function nodeEntry(
  node: WorkflowNode,
  input: { path: string[]; context: Record<string, unknown>; inheritedParent: string | undefined },
): Entry {
  const { path, context, inheritedParent } = input;
  const ancestor = titledNode(node.parent);
  const entry: Entry = {
    context,
    key: stateKey(path, node),
    meta: metadataSchema.parse(node.meta),
    node: node.id,
    path,
  };
  const parent = ancestor === undefined ? inheritedParent : stateKey(path, ancestor);
  if (parent !== undefined) entry.parent = parent;
  return entry;
}

function stateKey(path: string[], node: WorkflowNode): string {
  return JSON.stringify([path, node.id]);
}

function titledNode(node: WorkflowNode | undefined): WorkflowNode | undefined {
  let ancestor = node;
  while (ancestor !== undefined) {
    // Dynamic XState node metadata is validated by nodeEntry.
    // oxlint-disable-next-line typescript/no-unsafe-member-access
    if (ancestor.meta?.["title"] !== undefined) return ancestor;
    ancestor = ancestor.parent;
  }
  return undefined;
}
