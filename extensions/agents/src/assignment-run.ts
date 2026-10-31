import type { Context } from "@botlake/core";

import { agentLiveness } from "./liveness.ts";
import { agentAttributes } from "./node-model.ts";

export interface AssignmentRun {
  run: string;
  invocation: string | null;
}

/** Resolve only current, exact execution evidence for a newly established assignment. */
export function resolveAssignmentRun(ctx: Context, assignee: string): AssignmentRun | null {
  const reference = ctx.env.bl["BL_RUN_REFERENCE"];
  if (reference !== undefined) return resolveManagedReference(ctx, reference, assignee);

  const matches = ctx.graph.all({ lean: false }).filter((node) => {
    if (
      node.attributes[agentAttributes.run] !== true ||
      node.attributes[agentAttributes.external] !== true
    )
      return false;
    const liveness = agentLiveness(node);
    return (
      liveness.native &&
      liveness.identity === assignee &&
      liveness.audience === "agent" &&
      liveness.observation?.activity !== "ended"
    );
  });
  const [match] = matches;
  return matches.length === 1 && match !== undefined ? { run: match.id, invocation: null } : null;
}

function resolveManagedReference(
  ctx: Context,
  reference: string,
  assignee: string,
): AssignmentRun | null {
  const separator = reference.lastIndexOf(":");
  if (separator <= 0 || separator === reference.length - 1) return null;
  const runId = reference.slice(0, separator);
  const invocation = reference.slice(separator + 1);
  const run = ctx.graph
    .all({ lean: false })
    .find((node) => node.id === runId && node.attributes[agentAttributes.run] === true);
  if (run === undefined || run.attributes[agentAttributes.external] === true) return null;

  const liveness = agentLiveness(run);
  return liveness.kind === "managed" &&
    !liveness.settled &&
    liveness.audience === "agent" &&
    liveness.invocation === invocation &&
    liveness.identity === assignee
    ? { run: run.id, invocation }
    : null;
}
