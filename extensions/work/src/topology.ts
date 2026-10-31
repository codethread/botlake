import { z } from "zod";

import { text } from "./node-model.ts";
import type { WorkSummary, WorkTopology, WorkTopologyNode } from "./types.ts";

const commonInput = {
  id: text.optional(),
  state: z.enum(["open", "closed", "all"]).default("open"),
  lean: z.boolean().default(false),
  showDescription: z.boolean().default(false),
  showCriteria: z.boolean().default(false),
};

export const treeInput = z.compile(z.strictObject(commonInput));
export const graphInput = z.compile(
  z
    .strictObject({
      ...commonInput,
      direction: z.enum(["prerequisites", "dependents"]).optional(),
    })
    .check((ctx) => {
      if (ctx.value.id === undefined && ctx.value.direction !== undefined)
        ctx.issues.push({
          code: "custom",
          input: ctx.value,
          message: "Direction requires an id",
        });
    })
    .transform((input) => ({ ...input, direction: input.direction ?? "prerequisites" })),
);

export interface TopologySource {
  summaries: readonly WorkSummary[];
  parentEdges: readonly TopologyEdge[];
  dependencyEdges: readonly TopologyEdge[];
}

export interface TopologyEdge {
  from: string;
  to: string;
}

export function projectTree(
  source: TopologySource,
  options: z.output<typeof treeInput>,
): WorkTopology {
  const summaries = new Map(source.summaries.map((summary) => [summary.id, summary]));
  const scope =
    options.id === undefined
      ? new Set(summaries.keys())
      : reachable(options.id, source.parentEdges, "forward");
  const matching = new Set(
    [...scope].filter((id) => matchesState(required(summaries, id), options.state)),
  );
  if (options.id !== undefined) matching.add(options.id);

  const visible = new Set(matching);
  const context = new Set<string>();
  const parent = new Map(source.parentEdges.map((edge) => [edge.to, edge.from]));
  for (const id of matching) {
    let ancestor = parent.get(id);
    while (ancestor !== undefined && scope.has(ancestor) && !visible.has(ancestor)) {
      context.add(ancestor);
      visible.add(ancestor);
      ancestor = parent.get(ancestor);
    }
  }

  return assemble({
    source,
    options,
    view: "tree",
    direction: "children",
    relation: "parent-of",
    scoped: scope,
    visible,
    relevantEdges: source.parentEdges,
    context,
  });
}

export function projectGraph(
  source: TopologySource,
  options: z.output<typeof graphInput>,
): WorkTopology {
  const summaries = new Map(source.summaries.map((summary) => [summary.id, summary]));
  const scope =
    options.id === undefined
      ? new Set(summaries.keys())
      : reachable(
          options.id,
          source.dependencyEdges,
          options.direction === "prerequisites" ? "forward" : "reverse",
        );
  const visible = new Set(
    [...scope].filter((id) => matchesState(required(summaries, id), options.state)),
  );
  if (options.id !== undefined) visible.add(options.id);

  return assemble({
    source,
    options,
    view: "graph",
    direction: options.direction,
    relation: "depends-on",
    scoped: scope,
    visible,
    relevantEdges: source.dependencyEdges,
    context: new Set(),
  });
}

// -- Projection assembly --

interface Assembly {
  source: TopologySource;
  options: ReturnType<typeof treeInput.parse> | ReturnType<typeof graphInput.parse>;
  view: "tree" | "graph";
  direction: WorkTopology["direction"];
  relation: "parent-of" | "depends-on";
  scoped: ReadonlySet<string>;
  visible: ReadonlySet<string>;
  relevantEdges: readonly TopologyEdge[];
  context: ReadonlySet<string>;
}

function assemble(input: Assembly): WorkTopology {
  const summaries = new Map(input.source.summaries.map((summary) => [summary.id, summary]));
  const compareIds = (left: string, right: string) =>
    compareSummaries(required(summaries, left), required(summaries, right));
  const ids = [...input.visible].toSorted(compareIds);
  const scopedEdges = input.relevantEdges.filter(
    (edge) => input.scoped.has(edge.from) && input.scoped.has(edge.to),
  );
  const edges = scopedEdges
    .filter((edge) => input.visible.has(edge.from) && input.visible.has(edge.to))
    .map((edge) => ({ ...edge, relation: input.relation }))
    .toSorted((left, right) => {
      const from = compareIds(left.from, right.from);
      return from === 0 ? compareIds(left.to, right.to) : from;
    });
  const roots = rootIds(ids, edges, input.direction).toSorted(compareIds);
  if (input.options.id !== undefined) prefer(roots, input.options.id);

  return {
    view: input.view,
    root: input.options.id ?? null,
    roots,
    direction: input.direction,
    nodes: ids.map((id) => nodeView(required(summaries, id), input.options.lean)),
    edges,
    context: [...input.context].toSorted(compareIds),
    components: components(ids, edges, compareIds),
    omittedLinks: scopedEdges.filter(
      (edge) => input.visible.has(edge.from) !== input.visible.has(edge.to),
    ).length,
  };
}

function nodeView(summary: WorkSummary, lean: boolean): WorkTopologyNode {
  return lean ? { id: summary.id, title: summary.title, state: summary.state } : summary;
}

function reachable(
  root: string,
  edges: readonly TopologyEdge[],
  direction: "forward" | "reverse",
): Set<string> {
  const adjacent = new Map<string, string[]>();
  for (const edge of edges) {
    const from = direction === "forward" ? edge.from : edge.to;
    const to = direction === "forward" ? edge.to : edge.from;
    const neighbors = adjacent.get(from) ?? [];
    neighbors.push(to);
    adjacent.set(from, neighbors);
  }
  const found = new Set([root]);
  const pending = [root];
  for (let index = 0; index < pending.length; index += 1) {
    for (const id of adjacent.get(requiredIndex(pending, index)) ?? []) {
      if (found.has(id)) continue;
      found.add(id);
      pending.push(id);
    }
  }
  return found;
}

function rootIds(
  ids: readonly string[],
  edges: readonly TopologyEdge[],
  direction: WorkTopology["direction"],
): string[] {
  const nonroots = new Set(edges.map((edge) => (direction === "dependents" ? edge.from : edge.to)));
  return ids.filter((id) => !nonroots.has(id));
}

function components(
  ids: readonly string[],
  edges: readonly TopologyEdge[],
  compare: (left: string, right: string) => number,
): string[][] {
  const adjacent = new Map(ids.map((id) => [id, new Set<string>()]));
  for (const edge of edges) {
    adjacent.get(edge.from)?.add(edge.to);
    adjacent.get(edge.to)?.add(edge.from);
  }
  const unseen = new Set(ids);
  const result: string[][] = [];
  for (const start of ids) {
    if (!unseen.delete(start)) continue;
    const component = [start];
    for (let index = 0; index < component.length; index += 1) {
      for (const next of adjacent.get(requiredIndex(component, index)) ?? []) {
        if (!unseen.delete(next)) continue;
        component.push(next);
      }
    }
    result.push(component.toSorted(compare));
  }
  return result;
}

function compareSummaries(left: WorkSummary, right: WorkSummary): number {
  const priority = (left.priority ?? "P4").localeCompare(right.priority ?? "P4");
  if (priority !== 0) return priority;
  const title = left.title.localeCompare(right.title);
  return title === 0 ? left.id.localeCompare(right.id) : title;
}

function matchesState(summary: WorkSummary, state: "open" | "closed" | "all"): boolean {
  return state === "all" || summary.state === state;
}

function required<K, V>(map: ReadonlyMap<K, V>, key: K): V {
  const value = map.get(key);
  if (value === undefined) throw new Error(`Missing topology item: ${String(key)}`);
  return value;
}

function requiredIndex<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new Error(`Missing topology value at index ${index}`);
  return value;
}

function prefer(ids: string[], id: string): void {
  const index = ids.indexOf(id);
  if (index > 0) ids.unshift(...ids.splice(index, 1));
}
