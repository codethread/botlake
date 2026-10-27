import { createHash } from "node:crypto";

import { z } from "zod";

const text = z.string().trim().min(1);

export const providerSchema = z.enum(["codex", "pi", "claude"]);

export type ProviderName = z.infer<typeof providerSchema>;

export const sessionSchema = z.strictObject({
  provider: providerSchema,
  nativeSessionId: text,
});

export type NativeSession = z.infer<typeof sessionSchema>;

// The full provider/session pair is the authority; the digest is a portable attribution key.
export function sessionIdentity(session: NativeSession): string {
  return `agent-${createHash("sha256")
    .update(JSON.stringify([session.provider, session.nativeSessionId]))
    .digest("hex")}`;
}

export function identityInstruction(identity: string, shellEnvironment = false): string {
  const usage = shellEnvironment
    ? "bl kanban defaults authorship and claim ownership from BL_ACTOR in your shell environment; explicit flags override it. Use bl identity show to inspect your identity."
    : `For bl kanban add/note/claim, pass --by-identity ${identity}; for your own claims also pass --owner ${identity}. Inspect your identity with bl identity show ${identity}.`;
  return `Your Botlake identity is ${identity}. ${usage} Identity does not grant process custody or complete tasks.`;
}

export const agentMetadataSchema = z.strictObject({
  agentSeat: text.nullable().optional(),
  model: text.nullable().optional(),
  thinkingLevel: text.nullable().optional(),
});

// Only absent fields take caller defaults; explicit null means unknown, not inherited.
export function agentMetadata(
  input: z.infer<typeof agentMetadataSchema>,
  env: Readonly<Record<string, string | undefined>>,
): z.infer<typeof agentMetadataSchema> {
  return agentMetadataSchema.parse({
    agentSeat: input.agentSeat === undefined ? env["BL_AGENT_SEAT"] : input.agentSeat,
    model: input.model === undefined ? env["BL_MODEL"] : input.model,
    thinkingLevel: input.thinkingLevel === undefined ? env["BL_EFFORT"] : input.thinkingLevel,
  });
}

export const eventSchema = z.enum([
  "session-start",
  "agent-start",
  "agent-end",
  "session-end",
  "metadata",
]);

export type NativeEvent = z.infer<typeof eventSchema>;

export const capabilitySchema = z.enum(["activity", "model", "effort", "session-end", "parent"]);

export const observationSchema = sessionSchema.extend({
  cwd: text,
  event: eventSchema.default("session-start"),
  nativeEvent: text.optional(),
  ...agentMetadataSchema.shape,
  sessionPath: text.nullable().optional(),
  parentNativeSessionId: text.optional(),
  capabilities: z.array(capabilitySchema).optional(),
});

export type NativeObservation = z.infer<typeof observationSchema>;

export const registrationSchema = observationSchema
  .extend({
    runId: text.optional(),
    invocation: text.optional(),
  })
  .refine((value) => (value.runId === undefined) === (value.invocation === undefined), {
    message: "runId and invocation must be supplied together",
  });

export type NativeRegistration = z.infer<typeof registrationSchema>;

export const bindingSchema = z.strictObject({
  identity: text,
  nodeId: text,
  instruction: text,
  runId: text,
  external: z.boolean(),
  systemPrompt: z.string(),
});

export type NativeBinding = z.infer<typeof bindingSchema>;

export const activitySchema = z.enum(["unknown", "working", "idle", "ended"]);

export type Activity = z.infer<typeof activitySchema>;

export function observedActivity(event: NativeEvent, previous: Activity): Activity {
  switch (event) {
    case "session-start":
      return "unknown";
    case "agent-start":
      return "working";
    case "agent-end":
      return "idle";
    case "session-end":
      return "ended";
    case "metadata":
      return previous;
  }
}
