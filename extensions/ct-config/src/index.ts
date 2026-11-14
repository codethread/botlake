// oxlint-disable import/max-dependencies -- The shared preset intentionally composes its public extension descriptors.
import { fileURLToPath } from "node:url";

import { priming as createPriming } from "@botlake/core";
import {
  agentFlags,
  builtinProviders,
  agentReferenceProjections,
  agents as createAgents,
  type Alias,
} from "@botlake/extension-agents";
import { configureFlags } from "@botlake/extension-flags";
import { mail as createMail } from "@botlake/extension-mail";
import { mailAgents as createMailAgents } from "@botlake/extension-mail-agents";
import { mailIdentity as createMailIdentity } from "@botlake/extension-mail-identity";
import { references as createReferences } from "@botlake/extension-references";
import { ui as createUi } from "@botlake/extension-ui";
import {
  work as createWork,
  workReferenceProjections,
  type WorkOptions,
} from "@botlake/extension-work";
import { workAgents as createWorkAgents } from "@botlake/extension-work-agents";

import { agentPrimer, roster, rosterFlags } from "./roster.ts";

const mailHook = fileURLToPath(new URL("./mail/hook.ts", import.meta.url));
const mailPiExtension = fileURLToPath(new URL("./mail/pi.ts", import.meta.url));
const codexMailHook = `[ { hooks = [ { type = "command", command = ${JSON.stringify(`bun ${shellQuote(mailHook)}`)}, timeout = 5, additionalContextLimit = 4096 } ] } ]`;

export { agentPrimer, roster, rosterFlags } from "./roster.ts";

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

export const mail = createMail();

export const agents = configureAgents();

export const mailIdentity = createMailIdentity();

export const mailAgents = createMailAgents({ agents, mail });

export const priming = createPriming({
  work: [
    "Assign to the user via `--audience HITL --assignee=$(whoami)`",
    "Assigning to the user must only be done as a last resort when oracle can't unblock you or if given prior consent to do so",
    "Search for historical work before beginning to gather wider context",
    "Always work under a group, reuse existing where applicable, or re-open old groups if appropriate",
  ].join("\n"),
  agent: agentPrimer,
});

export const work = configureWork();

export const workAgents = createWorkAgents({ checkIntervalMs: 60_000 });

export const ui = createUi();

export function configureWork(
  options: Omit<WorkOptions, "references"> = {},
): ReturnType<typeof createWork> {
  return createWork({ ...options, references });
}

export function configureAgents(
  aliases: Record<string, Alias> = {},
): ReturnType<typeof createAgents> {
  const configured = createAgents({
    providers: [
      builtinProviders.codex({
        command: [
          "co",
          "--dangerously-bypass-hook-trust",
          "--config",
          "features.hooks=true",
          "--config",
          `hooks.SessionStart=${codexMailHook}`,
          "--config",
          `hooks.PostToolUse=${codexMailHook}`,
        ],
        flag: agentFlags.codex,
      }),
      builtinProviders.pi({
        command: ["piw", "-e", mailPiExtension],
        flag: agentFlags.pi,
      }),
      builtinProviders.claude({ bin: "cl", flag: agentFlags.claude }),
    ],
    ...roster,
    references,
    aliases: { ...roster.aliases, ...aliases },
  });
  configured.requires = [...(configured.requires ?? []), mail.name];
  return configured;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
