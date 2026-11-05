import { priming as createPriming, type Extension } from "@botlake/core";
import {
  agentFlags,
  agentReferenceProjections,
  agents as createAgents,
  type Alias,
} from "@botlake/extension-agents";
import { configureFlags } from "@botlake/extension-flags";
import { references as createReferences } from "@botlake/extension-references";
import {
  work as createWork,
  workReferenceProjections,
  type WorkOptions,
} from "@botlake/extension-work";
import { workAgents as createWorkAgents } from "@botlake/extension-work-agents";

import { agentPrimer, roster, rosterFlags } from "./roster.ts";

export { roster } from "./roster.ts";

export const flags = configureFlags([
  [agentFlags.codex, true],
  [agentFlags.pi, true],
  [agentFlags.claude, false],
  [rosterFlags.deepseek, true],
  [rosterFlags.fable, true],
]);

export const references = createReferences({
  projections: [...workReferenceProjections, ...agentReferenceProjections],
});

export const agents = configureAgents();

export const priming = createPriming({
  work: [
    "The Notes field is for recording a concise outcome before closing a task.",
    "Assign to the user via `--audience HTIL --assignee=$(whoami)`",
    "Assigning to the user must only be done as a last resort when oracle can't unblock you or if given prior consent to do so",
  ].join("\n"),
  agent: agentPrimer,
});

export const work = configureWork();

export const workAgents = createWorkAgents({ checkIntervalMs: 60_000 });

export function configureWork(options: Omit<WorkOptions, "references"> = {}): Extension {
  return createWork({ ...options, references });
}

export function configureAgents(aliases: Record<string, Alias> = {}): Extension {
  return createAgents({
    ...roster,
    references,
    aliases: { ...roster.aliases, ...aliases },
  });
}
