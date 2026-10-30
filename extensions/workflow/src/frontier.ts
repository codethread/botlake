import { z } from "zod";

import {
  actorContext,
  childActors,
  metadataSchema,
  type Metadata,
  type WorkflowActor,
  type WorkflowNode,
} from "./definition.ts";

const text = z.string().min(1);

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

// Adapted from Busy Bee's XState v5 active-hierarchy projection.
export function frontier(
  actor: WorkflowActor,
  path: string[] = [],
  inheritedParent?: string,
): Entry[] {
  const snapshot = actor.getSnapshot();
  if (snapshot.status !== "active") return [];
  const context = Object.fromEntries(
    Object.entries(actorContext(actor)).filter(([key]) => key !== "workers"),
  );
  // XState v5 exposes the active hierarchy here; keep this version-specific access local.
  // oxlint-disable-next-line no-underscore-dangle
  const entries = workNodes(snapshot._nodes).map((node) =>
    nodeEntry(node, { context, inheritedParent, path }),
  );
  for (const child of childActors(actor)) {
    const group = text.parse(actorContext(child)["group"]);
    entries.push(...frontier(child, [...path, child.id], `${path.join("/")}:${group}`));
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
  const ancestor = titledAncestor(node);
  const entry: Entry = {
    context,
    key: `${path.join("/")}:${node.id}`,
    meta: metadataSchema.parse(node.meta),
    node: node.id,
    path,
  };
  const parent = ancestor === undefined ? inheritedParent : `${path.join("/")}:${ancestor.id}`;
  if (parent !== undefined) entry.parent = parent;
  return entry;
}

function titledAncestor(node: WorkflowNode): WorkflowNode | undefined {
  let ancestor = node.parent;
  while (ancestor !== undefined) {
    // Dynamic XState node metadata is validated by nodeEntry.
    // oxlint-disable-next-line typescript/no-unsafe-member-access
    if (ancestor.meta?.["title"] !== undefined) return ancestor;
    ancestor = ancestor.parent;
  }
  return undefined;
}
