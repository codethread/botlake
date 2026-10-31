import { defineEvent, type Context, type Mutation } from "@botlake/core";
import { z } from "zod";

import { agentLiveness, agentLivenessSchema } from "./liveness.ts";
import { agentAttributes } from "./node-model.ts";

export const agentsChanged = defineEvent({
  name: "agents.changed",
  phase: "afterCommit",
  schema: z.object({ id: z.string(), liveness: agentLivenessSchema.nullable() }),
});

export function registerAgentEvents(ctx: Context): void {
  ctx.registerEvent(agentsChanged);
  ctx.subscribe((event) => {
    for (const [id, change] of [...changedRuns(event.changes)].toSorted(([a], [b]) =>
      a.localeCompare(b),
    ))
      ctx.emit(agentsChanged, {
        id,
        liveness: change.after === null ? null : agentLiveness(change.after),
      });
  });
}

function changedRuns(
  changes: readonly Mutation[],
): Map<string, Extract<Mutation, { kind: "node" }>> {
  const runs = new Map<string, Extract<Mutation, { kind: "node" }>>();
  for (const change of changes) {
    if (change.kind !== "node") continue;
    const run = change.after ?? change.before;
    if (
      run !== null &&
      (change.before?.attributes[agentAttributes.run] === true ||
        change.after?.attributes[agentAttributes.run] === true)
    )
      runs.set(run.id, change);
  }
  return runs;
}
