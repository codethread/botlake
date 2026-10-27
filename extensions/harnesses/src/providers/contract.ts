import { z } from "zod";

export const providerNameSchema = z.enum(["codex", "pi", "claude"]);

export type ProviderName = z.infer<typeof providerNameSchema>;

export interface ProviderSettings {
  model?: string | undefined;
  effort?: string | undefined;
  extraArgs: string[];
  systemPrompts: string[];
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
  name: ProviderName;
  doc: string;

  prepare(run: ProviderRun): LaunchPlan;

  finish(run: ProviderRun, exitCode: number, stdout: string, stderr: string): Outcome;
}
