import { brief as coreBrief, type PrimerCallback } from "@botlake/core";
import {
  brief as agentBrief,
  resolveSessionContext,
  type AgentConfig,
} from "@botlake/extension-agents";
import { flags } from "@botlake/extension-flags";
import { brief as workBrief } from "@botlake/extension-work";

const botlakePrompt = ["## Botlake", coreBrief, workBrief].join("\n");

const communicationPrompts = {
  human: [
    "Communicate efficiently. Be concise, but include assumptions, actions, and next steps when they matter.",
    "Always print file paths in vimgrep format, absolute from the git root (for example, `src/file.txt:42`), keeping content separate in fenced blocks.",
    "",
  ].join("\n"),
  agent: [
    "The user you are communicating with is another agent, so be clear and informative.",
    "The user only has access to your response, not any tool calls, so provide all relevant information in your response.",
  ].join("\n"),
  unknown: [].join("\n"),
};

export const rosterFlags = flags({
  deepseek: {
    name: "agents/deepseek",
    description: "Allow DeepSeek models.",
    default: true,
  },
  fable: {
    name: "agents/fable",
    description: "Enable Fable.",
    default: true,
  },
});

export const agentPrimer: PrimerCallback = (ctx, invocation) => {
  const session = resolveSessionContext(ctx, invocation);
  if (session === null) return "";
  if (session.seat === "oracle")
    return "You are the smartest agent, look for consensus from delegates not guidance";
  if (session.model?.startsWith("deepseek/") === true)
    return "You are the fastest agent, you will often find answers quicker through search than delegation";
  return "";
};

export const roster = {
  unmanaged: {
    systemPrompt: ({ audience }) =>
      [communicationPrompts[audience], botlakePrompt, agentBrief].join("\n"),
  },
  aliases: {
    deepseek: {
      doc: `DeepSeek V4.1 Flash. Fast, inexpensive coding for well-scoped acceptance criteria and established patterns.`,
      parent: "pi",
      model: "deepseek/deepseek-flash",
      effort: "max",
      when: rosterFlags.deepseek.name,
      systemPrompt: [communicationPrompts.agent, botlakePrompt].join("\n"),
    },
    luna: {
      doc: `GPT Luna. Implementation details, scouting and tightly scoped delegated tasks. Give explicit success criteria.`,
      parent: "pi",
      model: "openai-codex/gpt-6-luna",
      effort: "xhigh",
      systemPrompt: [communicationPrompts.agent, botlakePrompt].join("\n"),
    },
    "luna-codex": {
      doc: "GPT Luna through the native Codex harness.",
      parent: "codex",
      model: "gpt-6-luna",
      effort: "xhigh",
      systemPrompt: [communicationPrompts.agent, botlakePrompt].join("\n"),
    },
    opus: {
      doc: `Claude Opus. Greenfield features, API design and critical seams.`,
      parent: "claude",
      model: "opus",
      effort: "low",
      systemPrompt: [communicationPrompts.agent, botlakePrompt, agentBrief].join("\n"),
    },
    fable: {
      doc: `Claude Fable. Extreme diagnosis, top-level coordination and user-facing prose where writing is the product.`,
      parent: "claude",
      model: "claude-fable-5",
      effort: "high",
      when: rosterFlags.fable.name,
      systemPrompt: [communicationPrompts.agent, botlakePrompt, agentBrief].join("\n"),
    },
    astra: {
      doc: `GPT-6 Astra. Extreme diagnosis, top-level coordination, architecture and
        high-stakes user-facing prose.`,
      parent: "pi",
      model: "openai-codex/gpt-6-astra",
      effort: "high",
      systemPrompt: [communicationPrompts.agent, botlakePrompt, agentBrief].join("\n"),
    },
    sol: {
      doc: `GPT-5.6 Sol. Complex implementation, hostile-environment debugging and
        delegated coordination.`,
      parent: "pi",
      model: "openai-codex/gpt-5.6-sol",
      effort: "low",
      systemPrompt: [communicationPrompts.agent, botlakePrompt, agentBrief].join("\n"),
    },
    terra: {
      doc: `GPT-5.6 Terra. Well-defined, single-concern review and validation on
        clean checkouts.`,
      parent: "pi",
      model: "openai-codex/gpt-5.6-terra",
      effort: "high",
      systemPrompt: [communicationPrompts.agent, botlakePrompt, agentBrief].join("\n"),
    },
    oracle: {
      doc: `Default seat for high-stakes guidance, diagnosis and architecture.`,
      parent: "astra",
      effort: "high",
      systemPrompt: [communicationPrompts.agent, botlakePrompt, agentBrief].join("\n"),
    },
    reviewer: [
      {
        doc: `Default targeted review seat: prefer Sol.`,
        parent: "sol",
        systemPrompt: [communicationPrompts.agent, botlakePrompt, agentBrief].join("\n"),
      },
      {
        doc: `Targeted review fallback: Opus when Sol is unavailable.`,
        parent: "opus",
        systemPrompt: [communicationPrompts.agent, botlakePrompt, agentBrief].join("\n"),
      },
    ],
    grunt: [
      {
        doc: `Mechanical implementation, exploration and context-heavy file/log
          searching. Prefer DeepSeek.`,
        parent: "deepseek",
        systemPrompt: [communicationPrompts.agent, botlakePrompt, agentBrief].join("\n"),
      },
      {
        doc: `Mechanical implementation, exploration and context-heavy file/log
          searching. Fall back to Luna.`,
        parent: "luna",
        systemPrompt: [communicationPrompts.agent, botlakePrompt].join("\n"),
      },
    ],
  },
} satisfies AgentConfig;
