import { Fault, type Context, type Node } from "@botlake/core";
import { audienceSchema, type Activity, type Audience } from "@botlake/native-session";
import { z } from "zod";

import { runLifecycle } from "./lifecycle.ts";
import {
  agentAttributes,
  agentRunStateSchema,
  agentActivityObservationSchema,
} from "./node-model.ts";

interface SessionEvidence {
  /** Registered native identity, once the session has been observed. */
  identity: string | null;
  /** Intended recipient; only agent-audience work is eligible for automatic release. */
  audience: Audience;
  /** Whether a native adapter, rather than parsed output, supplied session evidence. */
  native: boolean;
  /** Last reported session activity, not proof that a process remains alive. */
  observation: { at: number; activity: Activity } | null;
}

export type AgentLiveness = SessionEvidence &
  (
    | {
        kind: "managed";
        /** Current attempt; delayed evidence must match this invocation. */
        invocation: string | null;
        /** Run lifecycle, independently of activity or useful progress. */
        state: z.infer<typeof agentRunStateSchema>;
        /** Custody has settled; silence or a stopped-but-uncertain run is insufficient. */
        settled: boolean;
      }
    | { kind: "external" }
  );

const sessionEvidenceSchema = {
  identity: z.string().nullable(),
  audience: audienceSchema,
  native: z.boolean(),
  observation: agentActivityObservationSchema.nullable(),
};

export const agentLivenessSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("managed"),
    ...sessionEvidenceSchema,
    invocation: z.string().nullable(),
    state: agentRunStateSchema,
    settled: z.boolean(),
  }),
  z.object({ kind: z.literal("external"), ...sessionEvidenceSchema }),
]);

/** Read the current liveness projection for a tracked run. */
export function readAgentLiveness(ctx: Context, id: string): AgentLiveness {
  return agentLiveness(ctx.graph.show(id));
}

/** Interpret a current or committed run snapshot without losing the attempt's custody evidence. */
export function agentLiveness(run: Node): AgentLiveness {
  const { attributes } = run;
  if (attributes[agentAttributes.run] !== true) throw new Fault("agent", "Expected agent run");
  const observation = attributes[agentAttributes.observation];
  const identity = attributes[agentAttributes.identity];
  const invocation = attributes[agentAttributes.invocation];
  const session: SessionEvidence = {
    identity: typeof identity === "string" ? identity : null,
    audience: audienceSchema.parse(attributes[agentAttributes.audience]),
    native: attributes[agentAttributes.integration] === "native",
    observation:
      observation === null || observation === undefined
        ? null
        : agentActivityObservationSchema.parse(observation),
  };
  if (attributes[agentAttributes.external] === true) return { kind: "external", ...session };
  return {
    kind: "managed",
    ...session,
    invocation: typeof invocation === "string" ? invocation : null,
    state: agentRunStateSchema.parse(attributes[agentAttributes.state]),
    settled: runLifecycle(run).hasTag("settled"),
  };
}
