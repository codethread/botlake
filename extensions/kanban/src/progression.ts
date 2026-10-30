import { Fault, nodeSchema, q, type Context, type Graph, type Node } from "@botlake/core";
import { z } from "zod";

export const progressionSchema = z.compile(z.enum(["children", "free"]));
const burnSchema = z.object({ node: nodeSchema });
/**
 * Child-gated progression is opt-in through kanban/progression="children".
 * The policy follows parent-of descendants regardless of Kanban attributes.
 * Every check reads the final transaction state with full (non-lean) attributes,
 * so archived data cannot hide an opt-in and intermediate snapshots cannot lie.
 */
export function protectProgression(ctx: Context): void {
  // Guards receive one mutation at a time. Retain committed containment for batched detach checks.
  const committedParents = new Map(
    ctx.graph
      .edges(undefined, "parent-of")
      .map((edge) => [JSON.stringify([edge.from_id, edge.to_id]), edge]),
  );
  ctx.graph.protect((changes) => {
    for (const change of changes) {
      if (change.kind !== "edge") continue;
      const edge = change.before ?? change.after;
      if (edge?.relation !== "parent-of") continue;
      ctx.graph.afterCommit(() => {
        const key = JSON.stringify([edge.from_id, edge.to_id]);
        const retained = ctx.graph.edge(edge.from_id, edge.to_id, "parent-of");
        if (retained === null) committedParents.delete(key);
        else committedParents.set(key, retained);
      });
    }
    for (const change of changes) {
      if (change.kind === "edge") {
        const edge = change.after ?? change.before;
        if (edge?.relation !== "parent-of") continue;
        if (ctx.graph.edge(edge.from_id, edge.to_id, edge.relation) === null) {
          assertRemovableChild(ctx.graph, edge.from_id, edge.to_id, [...committedParents.values()]);
          continue;
        }
        const child = finalNode(ctx.graph, edge.to_id);
        if (child === undefined) continue;
        for (const node of ctx.graph.subgraph(child.id).nodes)
          if (node.state !== "closed") assertActiveChildAllowed(ctx.graph, node);
        continue;
      }

      if (change.after === null) continue;
      const after = finalNode(ctx.graph, change.after.id);
      if (after === undefined) continue;
      const unresolved = policyApplies(ctx.graph, after.id)
        ? unresolvedDescendants(ctx.graph, after.id)
        : [];
      if (unresolved.length > 0 && (advanced(after) || after.state !== "active"))
        throw new Fault("progression", "Finish contained work before advancing or closing", {
          id: after.id,
          unfinished: unresolved.map(({ id, title }) => ({ id, title })),
        });

      if (after.state === "active" && change.before?.state !== "active")
        assertActiveChildAllowed(ctx.graph, after);
    }
  });
}

export function policyApplies(graph: Graph, id: string): boolean {
  const seen = new Set<string>();
  const pending = [id];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    const node = finalNode(graph, current);
    if (node === undefined) continue;
    if (node.attributes["kanban/progression"] === "children") return true;
    pending.push(...parents(graph, node.id));
  }
  return false;
}

export function unresolvedDescendants(graph: Graph, id: string): Node[] {
  return graph.subgraph(id).nodes.filter((node) => node.id !== id && node.state !== "closed");
}

// -- Private helpers --

function assertRemovableChild(
  graph: Graph,
  parent: string,
  child: string,
  oldParents: { from_id: string; to_id: string }[],
): void {
  if (!policyAppliesBeforeRemoval(graph, parent, oldParents)) return;
  const node = finalNode(graph, child);
  const state = node?.state ?? deletedNode(graph, child)?.state;
  if (
    state === "closed" &&
    (node === undefined || unresolvedDescendants(graph, child).length === 0)
  )
    return;
  throw new Fault(
    "progression",
    "Finish contained work before removing it from a child-gated parent",
    { parent, child },
  );
}

function policyAppliesBeforeRemoval(
  graph: Graph,
  id: string,
  oldParents: { from_id: string; to_id: string }[],
): boolean {
  const seen = new Set<string>();
  const pending = [id];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    const node = finalNode(graph, current) ?? deletedNode(graph, current);
    if (node?.attributes["kanban/progression"] === "children") return true;
    pending.push(...parents(graph, current));
    for (const edge of oldParents) if (edge.to_id === current) pending.push(edge.from_id);
  }
  return false;
}

function deletedNode(graph: Graph, id: string): Node | undefined {
  const row = graph.tombstones(id).at(-1);
  if (row === undefined) return undefined;
  return burnSchema.parse(JSON.parse(z.object({ snapshot: z.string() }).parse(row).snapshot)).node;
}

function finalNode(graph: Graph, id: string): Node | undefined {
  return graph.all({ where: q.eq("id", id), lean: false })[0];
}

function parents(graph: Graph, id: string): string[] {
  return graph
    .edges(id, "parent-of")
    .filter((edge) => edge.to_id === id)
    .map((edge) => edge.from_id);
}

function assertActiveChildAllowed(graph: Graph, child: Node): void {
  const pending = parents(graph, child.id);
  const seen = new Set<string>();
  while (pending.length > 0) {
    const parent = pending.pop();
    if (parent === undefined || seen.has(parent)) continue;
    seen.add(parent);
    pending.push(...parents(graph, parent));
    if (!policyApplies(graph, parent)) continue;
    const node = finalNode(graph, parent);
    if (node === undefined || (!advanced(node) && !successfulClose(node))) continue;
    throw new Fault(
      "progression",
      "Move the parent back or reopen it before activating contained work",
      { parent, child: child.id },
    );
  }
}

function advanced(node: Node): boolean {
  return (
    node.state === "active" &&
    (node.attributes["kanban/lane"] === "in_review" ||
      node.attributes["kanban/lane"] === "in_production")
  );
}

function successfulClose(node: Node): boolean {
  return node.state === "closed" && node.attributes["kanban/outcome"] !== "abandoned";
}
