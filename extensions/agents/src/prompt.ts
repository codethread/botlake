import type { Audience } from "@botlake/native-session";
import { z } from "zod";

import type { ProviderName } from "./providers/contract.ts";

export const systemPromptSchema = z.compile(
  z.union([
    z.string(),
    z.custom<(context: SessionContext) => string>((value) => typeof value === "function"),
  ]),
);

const text = z.compile(z.string());

export interface SessionContext {
  provider: ProviderName;
  /** Intended recipient, independent of whether the session has a UI. */
  audience: Audience;
  model: string | null;
  effort: string | null;
  seat: string | null;
  cwd: string;
  workspace: string;
}

export type SystemPrompt = string | ((context: SessionContext) => string);

export function resolveSystemPrompt(
  source: SystemPrompt | undefined,
  context: SessionContext,
): string {
  return typeof source === "function" ? text.parse(source(context)) : (source ?? "");
}
