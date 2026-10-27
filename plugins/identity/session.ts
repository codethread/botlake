import { realpathSync } from "node:fs";

import {
  bindingSchema,
  identityInstruction,
  sessionIdentity,
  type NativeBinding,
  type NativeObservation,
} from "@botlake/native-session";

import { bl, nativeProject } from "./client.ts";

export interface SessionReport {
  identity: string;
  instruction: string;
  tracking: "registered" | "unavailable" | "outside-workspace";
  binding?: NativeBinding;
  error?: string;
}

// Identity is local and deterministic. Registration is observational, not permission to run.
export async function reportNative(
  observation: NativeObservation,
  env: NodeJS.ProcessEnv,
  unmanaged = false,
): Promise<SessionReport> {
  const identity = sessionIdentity(observation);
  const local = { identity, instruction: identityInstruction(identity) };

  try {
    const explicit = env["BOTLAKE_WORKSPACE"];
    const workspace =
      explicit === undefined ? await nativeProject(observation.cwd) : realpathSync(explicit);
    if (workspace === null) return { ...local, tracking: "outside-workspace" };
    const reference = unmanaged ? undefined : env["BOTLAKE_RUN_REFERENCE"];
    const parts = reference?.split(":");
    if (parts !== undefined && (parts.length !== 2 || parts.some((part) => part.length === 0)))
      throw new Error("Malformed managed run reference");

    const binding = bindingSchema.parse(
      await bl(
        workspace,
        {
          command: "native",
          ...observation,
          ...(parts === undefined ? {} : { runId: parts[0], invocation: parts[1] }),
        },
        env,
      ),
    );
    if (binding.identity !== identity)
      throw new Error("Database returned a different native identity");

    return { ...local, tracking: "registered", binding };
  } catch (error) {
    const message = `Botlake tracking unavailable: ${String(error)}`;
    process.stderr.write(`${message}\n`);
    return { ...local, tracking: "unavailable", error: message };
  }
}

export function sessionEnvironment(observation: NativeObservation): Record<string, string> {
  return {
    BOTLAKE_IDENTITY: sessionIdentity(observation),
    BOTLAKE_NATIVE_SESSION_ID: observation.nativeSessionId,
    BOTLAKE_NATIVE_PROVIDER: observation.provider,
  };
}
