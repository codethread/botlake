import { match } from "ts-pattern";

import type { Gate, GateCommand, GateStatus, GateTransition } from "./types.ts";

export function transitionGate(
  gate: Pick<Gate, "status" | "policy">,
  command: GateCommand,
): GateTransition {
  return match(gate.status)
    .with({ status: "cleared" }, { status: "dismissed" }, () => ({
      kind: "refused" as const,
      code: "closed" as const,
      message: "Gate is already closed",
    }))
    .with(
      { status: "pending" },
      { status: "waiting" },
      { status: "exhausted" },
      (from): GateTransition => transitionOpen(from, gate.policy, command),
    )
    .exhaustive();
}

function transitionOpen(
  from: Exclude<GateStatus, { status: "cleared" | "dismissed" }>,
  policy: Gate["policy"],
  command: GateCommand,
): GateTransition {
  return match(command)
    .with({ type: "retry" }, () => ({
      kind: "moved" as const,
      from,
      to: { status: "pending" as const, round: roundOf(from) + 1 },
    }))
    .with({ type: "clear" }, (value) => ({
      kind: "moved" as const,
      from,
      to: {
        status: "cleared" as const,
        at: value.at,
        by: value.by,
        via: "actor" as const,
        message: value.message,
      },
    }))
    .with({ type: "dismiss" }, (value) => ({
      kind: "moved" as const,
      from,
      to: { status: "dismissed" as const, at: value.at, by: value.by, reason: value.reason },
    }))
    .with({ type: "attempt" }, (value): GateTransition => {
      const expected =
        from.status === "pending" ? 1 : from.status === "waiting" ? from.attempts + 1 : null;
      if (value.round !== roundOf(from) || value.attempt !== expected)
        return {
          kind: "refused",
          code: "stale",
          message: `Expected round ${roundOf(from)} attempt ${expected ?? "none"}`,
        };
      if (value.result.outcome === "passed")
        return {
          kind: "moved",
          from,
          to: {
            status: "cleared",
            at: value.at,
            by: value.by,
            via: "probe",
            message: value.result.message,
            ...(value.result.evidence === undefined ? {} : { evidence: value.result.evidence }),
          },
        };
      const last = {
        at: value.result.at,
        outcome: value.result.outcome,
        message: value.result.message,
        ...(value.result.evidence === undefined ? {} : { evidence: value.result.evidence }),
      };
      return {
        kind: "moved",
        from,
        to:
          value.attempt >= policy.maxAttempts
            ? { status: "exhausted", round: value.round, attempts: value.attempt, last }
            : {
                status: "waiting",
                round: value.round,
                attempts: value.attempt,
                last,
                nextAt: new Date(Date.parse(value.at) + policy.everyMs).toISOString(),
              },
      };
    })
    .exhaustive();
}

function roundOf(status: Exclude<GateStatus, { status: "cleared" | "dismissed" }>): number {
  return status.round;
}
