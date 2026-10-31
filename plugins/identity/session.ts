import { realpathSync } from "node:fs";

import {
  agentMetadata,
  bindingSchema,
  identityInstruction,
  sessionIdentity,
  sessionAudience,
  type NativeBinding,
  type NativeObservation,
} from "@botlake/native-session";

import { bl, nativeProject } from "./client.ts";

export interface SessionReport {
  /** Deterministic attribution for the native provider/session pair. */
  identity: string;
  /** Host-facing attribution guidance. */
  instruction: string;
  /** Project context supplied by the lake, or empty when unavailable. */
  systemPrompt: string;
  /** Outcome of attempting to register this observation. */
  tracking: "registered" | "unavailable" | "outside-workspace";
  /** Persisted linkage, supplied when registration succeeds. */
  binding?: NativeBinding;
  /** User-visible tracking failure, when registration is unavailable. */
  error?: string;
}

// Identity is local and deterministic. Registration is observational, not permission to run.
export async function reportNative(
  observation: NativeObservation,
  env: NodeJS.ProcessEnv,
  unmanaged = false,
): Promise<SessionReport> {
  const identity = sessionIdentity(observation);
  const local = { identity, instruction: identityInstruction(identity), systemPrompt: "" };

  try {
    const explicit = env["BL_WORKSPACE"];
    const workspace =
      explicit === undefined ? await nativeProject(observation.cwd) : realpathSync(explicit);
    if (workspace === null) return { ...local, tracking: "outside-workspace" };
    const reference = unmanaged ? undefined : env["BL_RUN_REFERENCE"];
    const parts = reference?.split(":");
    if (parts !== undefined && (parts.length !== 2 || parts.some((part) => part.length === 0)))
      throw new Error("Malformed managed run reference");

    const binding = bindingSchema.parse(
      await bl(
        workspace,
        {
          command: "native",
          ...observation,
          audience: sessionAudience({ ...observation, runId: parts?.[0] }, env),
          ...(parts === undefined ? {} : { runId: parts[0], invocation: parts[1] }),
        },
        env,
      ),
    );
    if (binding.identity !== identity)
      throw new Error("Database returned a different native identity");

    return { ...local, systemPrompt: binding.systemPrompt, tracking: "registered", binding };
  } catch (error) {
    const message = `Botlake tracking unavailable: ${String(error)}`;
    process.stderr.write(`${message}\n`);
    return { ...local, tracking: "unavailable", error: message };
  }
}

export function sessionEnvironment(
  observation: NativeObservation,
  env: NodeJS.ProcessEnv,
): Record<string, string | undefined> {
  const metadata = agentMetadata(observation, env);
  return {
    BL_ACTOR: sessionIdentity(observation),
    BL_AGENT_SEAT: metadata.agentSeat ?? undefined,
    BL_MODEL: metadata.model ?? undefined,
    BL_EFFORT: metadata.thinkingLevel ?? undefined,
    BL_NATIVE_SESSION_ID: observation.nativeSessionId,
    BL_NATIVE_PROVIDER: observation.provider,
  };
}
