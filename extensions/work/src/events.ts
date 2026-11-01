import { defineEvent, type Context, type Graph, type Mutation } from "@botlake/core";
import { z } from "zod";

import { assignmentSchema, workAttributes, workRelations } from "./node-model.ts";

const workRelationLabels: readonly string[] = Object.values(workRelations);

export const workChanged = defineEvent({
  name: "work.changed",
  phase: "afterCommit",
  schema: z.object({ ids: z.array(z.string()) }),
});

export const workAssignmentEstablished = defineEvent({
  name: "work.assignment-established",
  phase: "transactional",
  schema: z.object({ task: z.string(), assignment: assignmentSchema }),
});

export function registerWorkEvents(ctx: Context): void {
  ctx.registerEvent(workChanged);
  ctx.registerEvent(workAssignmentEstablished);
  ctx.subscribe((event) => {
    const ids = changedWorkIds(event.changes, ctx.graph);
    if (ids.length > 0) ctx.emit(workChanged, { ids });
  });
}

function changedWorkIds(changes: readonly Mutation[], graph: Graph): string[] {
  const ids = new Set<string>();
  for (const change of changes) {
    if (change.kind === "node") {
      const node = change.after ?? change.before;
      if (node !== null && node.reference !== null) {
        const dependents = graph
          .edges(node.id)
          .filter(
            (edge) =>
              edge.to_id === node.id &&
              workRelationLabels.includes(edge.relation) &&
              graph.show(edge.from_id).attributes[workAttributes.item] === true,
          );
        for (const edge of dependents) ids.add(edge.from_id);
      }
      if (
        node !== null &&
        (change.before?.attributes[workAttributes.item] === true ||
          change.after?.attributes[workAttributes.item] === true)
      )
        ids.add(node.id);
      continue;
    }
    const edge = change.after ?? change.before;
    if (edge === null || !workRelationLabels.includes(edge.relation)) continue;
    ids.add(edge.from_id);
    ids.add(edge.to_id);
  }
  return [...ids].toSorted();
}
