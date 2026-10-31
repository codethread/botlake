import { defineEvent, type Context, type Mutation } from "@botlake/core";
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
    const ids = changedWorkIds(event.changes);
    if (ids.length > 0) ctx.emit(workChanged, { ids });
  });
}

function changedWorkIds(changes: readonly Mutation[]): string[] {
  const ids = new Set<string>();
  for (const change of changes) {
    if (change.kind === "node") {
      const node = change.after ?? change.before;
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
