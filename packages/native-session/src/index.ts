import { createHash } from "node:crypto";

import { adjectives, animals, uniqueNamesGenerator } from "unique-names-generator";
import { z } from "zod";

const text = z.string().trim().min(1);

export const providerSchema = z.enum(["codex", "pi", "claude"]);

export const audienceSchema = z.enum(["human", "agent", "unknown"]);
const audienceOverrideSchema = z.enum(["human", "agent"], {
  error: "BL_AUDIENCE must be human or agent",
});

export const sessionSchema = z.strictObject({
  provider: providerSchema,
  nativeSessionId: text,
});

export const agentMetadataSchema = z.strictObject({
  agentSeat: text.nullable().optional(),
  model: text.nullable().optional(),
  thinkingLevel: text.nullable().optional(),
});

export const eventSchema = z.enum([
  "session-start",
  "agent-start",
  "agent-end",
  "session-end",
  "metadata",
]);

export const capabilitySchema = z.enum(["activity", "model", "effort", "session-end", "parent"]);

export const observationSchema = sessionSchema.extend({
  cwd: text,
  event: eventSchema.default("session-start"),
  nativeEvent: text.optional(),
  audience: audienceSchema.optional(),
  ...agentMetadataSchema.shape,
  sessionPath: text.nullable().optional(),
  parentNativeSessionId: text.optional(),
  capabilities: z.array(capabilitySchema).optional(),
});

export const registrationSchema = observationSchema
  .extend({
    runId: text.optional(),
    invocation: text.optional(),
  })
  .refine((value) => (value.runId === undefined) === (value.invocation === undefined), {
    message: "runId and invocation must be supplied together",
  });

export const bindingSchema = z.strictObject({
  identity: text,
  nodeId: text,
  instruction: text,
  runId: text,
  external: z.boolean(),
  systemPrompt: z.string(),
});

export const activitySchema = z.enum(["unknown", "working", "idle", "ended"]);

export type ProviderName = z.infer<typeof providerSchema>;

export type Audience = z.infer<typeof audienceSchema>;

export type NativeSession = z.infer<typeof sessionSchema>;

export type NativeEvent = z.infer<typeof eventSchema>;

export type NativeObservation = z.infer<typeof observationSchema>;

export type NativeRegistration = z.infer<typeof registrationSchema>;

export type NativeBinding = z.infer<typeof bindingSchema>;

export type Activity = z.infer<typeof activitySchema>;

// The provider/session pair is authoritative; the three-word name is for attribution.
export function sessionIdentity(session: NativeSession): string {
  return uniqueNamesGenerator({
    dictionaries: [adjectives, adjectives, animals],
    separator: "-",
    // The library treats zero as unseeded, so use a strictly positive seed.
    seed:
      createHash("sha256")
        .update(JSON.stringify([session.provider, session.nativeSessionId]))
        .digest()
        .readUInt32BE(0) + 1,
  });
}

export function identityInstruction(identity: string, shellEnvironment = false): string {
  const usage = shellEnvironment
    ? "Commands supporting identity attribution default to `BL_ACTOR` in your shell environment; explicit flags override it."
    : `Where supported, pass \`--by-identity ${identity}\` for authorship and \`--owner ${identity}\` for ownership.`;
  return [
    `Your Botlake identity is ${identity}.`,
    usage,
    "Identity is attribution, not process custody or task completion.",
    `Inspect it with \`bl identity show${shellEnvironment ? "" : ` ${identity}`}\`.`,
  ].join(" ");
}

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

/** Managed runs and explicitly observed native children never inherit a caller override. */
export function sessionAudience(
  input: Pick<NativeRegistration, "audience" | "runId" | "nativeEvent">,
  env: Readonly<Record<string, string | undefined>>,
): Audience {
  if (
    input.runId !== undefined ||
    input.nativeEvent === "SubagentStart" ||
    input.nativeEvent === "SubagentStop"
  )
    return "agent";
  if (input.audience !== undefined) return input.audience;
  const override = env["BL_AUDIENCE"];
  return override === undefined ? "unknown" : audienceOverrideSchema.parse(override);
}

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
