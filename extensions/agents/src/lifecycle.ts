import { Fault, type Attributes, type Node } from "@botlake/core";
import { initialTransition, setup, transition, type SnapshotFrom } from "xstate";
import type { z } from "zod";

import { agentAttributes, agentLifecycleSchema } from "./node-model.ts";

interface LifecycleEvent {
  type:
    | "LAUNCH"
    | "ABANDON"
    | "STOP_UNCERTAIN"
    | "RECONCILIATION_FAILED"
    | "COMPLETED"
    | "CANCELLED"
    | "LAUNCH_FAILED"
    | "EXECUTION_FAILED"
    | "SESSION_FAILED"
    | "RETRY";
}

const custodyEvents = {
  STOP_UNCERTAIN: { target: "awaitingExit" },
  RECONCILIATION_FAILED: { target: "reconciling" },
  COMPLETED: { target: "completed" },
  CANCELLED: { target: "cancelled" },
  LAUNCH_FAILED: { target: "launchFailed" },
  EXECUTION_FAILED: { target: "executionFailed" },
  SESSION_FAILED: { target: "sessionFailed" },
} as const;
const retryable = { tags: ["settled"], on: { RETRY: { target: "pending" } } } as const;

// No actors, actions or timers: process custody supplies facts; the machine decides transitions.
const lifecycle = setup<Record<string, never>, LifecycleEvent>({}).createMachine({
  id: "agent-run",
  context: {},
  initial: "pending",
  states: {
    pending: {
      tags: ["unlaunched"],
      on: {
        LAUNCH: "running",
        ABANDON: "abandoned",
        RECONCILIATION_FAILED: "preparationFailed",
      },
    },
    running: { tags: ["launched"], on: custodyEvents },
    awaitingExit: { tags: ["launched"], on: custodyEvents },
    reconciling: { tags: ["launched"], on: custodyEvents },
    completed: { tags: ["settled"] },
    cancelled: { tags: ["settled"] },
    abandoned: { tags: ["settled", "unlaunched"] },
    launchFailed: retryable,
    executionFailed: retryable,
    sessionFailed: retryable,
    preparationFailed: { ...retryable, tags: ["settled", "unlaunched"] },
  } satisfies Record<z.infer<typeof agentLifecycleSchema>, unknown>,
});

type Lifecycle = SnapshotFrom<typeof lifecycle>;

/** Restore only the state value: this pure machine has no actor, context or pending effects. */
export function runLifecycle({ attributes }: Node): Lifecycle {
  return lifecycle.resolveState({
    value: agentLifecycleSchema.parse(attributes[agentAttributes.lifecycle]),
    context: {},
  });
}

export function initialLifecycleAttributes(): Attributes {
  return lifecycleAttributes(initialTransition(lifecycle)[0]);
}

/** Persist the machine state and every indexed/display projection in the same graph update. */
export function transitionRun(
  run: Node,
  event: LifecycleEvent,
): { attributes: Attributes; state: "active" | "closed" } {
  const current = runLifecycle(run);
  if (!current.can(event))
    throw new Fault("attempt", `Cannot ${event.type} an agent run in ${current.value}`);
  const [next] = transition(lifecycle, current, event);
  return {
    attributes: lifecycleAttributes(next),
    state: next.matches("pending") || next.matches("running") ? "active" : "closed",
  };
}

// -- Private helpers --

function lifecycleAttributes(snapshot: Lifecycle): Attributes {
  const [state, substatus] = displayStatus(snapshot.value);
  return {
    [agentAttributes.lifecycle]: snapshot.value,
    [agentAttributes.state]: state,
    [agentAttributes.substatus]: substatus,
    [agentAttributes.settled]: snapshot.hasTag("settled"),
  };
}

function displayStatus(value: Lifecycle["value"]): [string, string] {
  switch (value) {
    case "pending":
      return ["ready", "pending"];
    case "running":
      return ["running", "pending"];
    case "awaitingExit":
      return ["stopped", "requested"];
    case "reconciling":
    case "preparationFailed":
      return ["failed", "reconciliation"];
    case "completed":
      return ["stopped", "completed"];
    case "cancelled":
      return ["stopped", "requested"];
    case "abandoned":
      return ["stopped", "abandoned"];
    case "launchFailed":
      return ["failed", "launch"];
    case "executionFailed":
      return ["failed", "execution"];
    case "sessionFailed":
      return ["failed", "native-session"];
  }
}
