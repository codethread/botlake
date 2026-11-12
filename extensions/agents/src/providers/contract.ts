import type { FlagDefinition } from "@botlake/extension-flags";
import type { ProviderName } from "@botlake/native-session";
import { z } from "zod";

export type { ProviderName } from "@botlake/native-session";

const commandSchema = z.compile(
  z
    .strictObject({
      bin: z.string().min(1).optional(),
      command: z
        .tuple([z.string().min(1)])
        .rest(z.string())
        .optional(),
    })
    .refine(({ bin, command }) => bin === undefined || command === undefined, {
      message: "bin and command are mutually exclusive",
    }),
);

export type BuiltinProviderOptions = {
  /** Optional caller-owned gate; omission makes the provider always available. */
  flag?: FlagDefinition;
} & (
  | {
      /** Single executable, resolved through PATH unless a path is supplied. */
      bin?: string;
      command?: never;
    }
  | {
      bin?: never;
      /** Executable and base arguments, before provider-owned protocol arguments. */
      command: readonly [string, ...string[]];
    }
);

export interface ProviderSettings {
  model?: string | undefined;
  effort?: string | undefined;
  extraArgs: string[];
  systemPrompt: string;
}

export type ProviderRun = ProviderSettings & {
  provider: ProviderName;
  cwd: string;
  prompt: string;
} & ({ resumes: false; sessionId?: never } | { resumes: true; sessionId: string });

export interface LaunchPlan {
  command: string[];
  stdin: string;
  env: Record<string, string>;
}

export interface Outcome {
  success: boolean;
  result: string | null;
  sessionId: string | null;
  error: string | null;
}

export interface Provider {
  /** Unique provider and native-session namespace. */
  name: ProviderName;
  /** Catalog guidance for choosing this provider. */
  doc: string;
  /** Optional caller-owned availability flag. */
  flag?: FlagDefinition;

  prepare(run: ProviderRun): LaunchPlan;

  finish(run: ProviderRun, exitCode: number, stdout: string, stderr: string): Outcome;
}

export function providerCommand(defaultBin: string, options: BuiltinProviderOptions): string[] {
  const { bin, command } = commandSchema.parse({ bin: options.bin, command: options.command });
  return command ?? [bin ?? defaultBin];
}
