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

    fable: {
      doc: `Claude Fable. Extreme diagnosis, top-level coordination and user-facing prose where writing is the product.`,
      parent: "claude",
      model: "fable",
      effort: "high",
      when: rosterFlags.fable.name,
      systemPrompt: [communicationPrompts.agent, botlakePrompt, agentBrief].join("\n"),
    },
    opus: {
      doc: `Claude Opus. Greenfield features, API design and critical seams.`,
      parent: "claude",
      model: "opus",
      effort: "high",
      systemPrompt: [communicationPrompts.agent, botlakePrompt, agentBrief].join("\n"),
    },
    sonnet: {
      doc: `Claude Sonnet, fast worker, effective but less thorough`,
      parent: "claude",
      model: "sonnet",
      effort: "high",
      systemPrompt: [communicationPrompts.agent, botlakePrompt, agentBrief].join("\n"),
    },
    haiku: {
      doc: `Claude Haiku, fast cheap model, use for mechanical changes, not autonomous thinking or testing claude harness configurations`,
      parent: "claude",
      model: "haiku",
      effort: "high",
      systemPrompt: [communicationPrompts.agent, botlakePrompt].join("\n"),
    },

    astra: {
      doc: `GPT Astra. Extreme diagnosis, top-level coordination, architecture and high-stakes user-facing prose.`,
      parent: "pi",
      model: "openai-codex/gpt-6.2-astra",
      effort: "high",
      systemPrompt: [communicationPrompts.agent, botlakePrompt, agentBrief].join("\n"),
    },
    sol: {
      doc: `GPT Sol. Complex implementation, hostile-environment debugging and delegated coordination.`,
      parent: "pi",
      model: "openai-codex/gpt-6.2-sol",
      effort: "high",
      systemPrompt: [communicationPrompts.agent, botlakePrompt, agentBrief].join("\n"),
    },
    terra: {
      doc: `GPT Terra. Well-defined, single-concern review and validation on clean checkouts.`,
      parent: "pi",
      model: "openai-codex/gpt-6.1-terra",
      effort: "high",
      systemPrompt: [communicationPrompts.agent, botlakePrompt, agentBrief].join("\n"),
    },
    luna: {
      doc: `GPT Luna. Small model, slow, cheap. Clear mechanical grunt work, like a smart bash script where it will handle more edge cases or filter details.
Good for handling larger data sets to that might otherwise consume working agents' context`,
      parent: "pi",
      model: "openai-codex/gpt-6-luna",
      effort: "xhigh",
      systemPrompt: [communicationPrompts.agent, botlakePrompt].join("\n"),
    },

    oracle: [
      {
        doc: `Default seat for high-stakes guidance, diagnosis and architecture.`,
        parent: "fable",
        effort: "high",
        systemPrompt: [communicationPrompts.agent, botlakePrompt, agentBrief].join("\n"),
      },
      {
        doc: `Default seat for high-stakes guidance, diagnosis and architecture.`,
        parent: "astra",
        effort: "high",
        systemPrompt: [communicationPrompts.agent, botlakePrompt, agentBrief].join("\n"),
      },
    ],

    researcher: {
      doc: `Online researcher agent, has access to powerful search tools.
Cheap enough to spawn multiple for split stream research instead of a single deep research task`,
      parent: "codex",
      model: "gpt-6.1-terra",
      effort: "high",
      systemPrompt: [communicationPrompts.agent, botlakePrompt].join("\n"),
    },

    reviewer: [
      {
        doc: `Strong code review agent, very thorough, can be over sensitive, take steer but do not see all feedback as required, find pragmatic balance`,
        parent: "sol",
        systemPrompt: [communicationPrompts.agent, botlakePrompt, agentBrief].join("\n"),
      },
      {
        doc: `Strong code review agent, very thorough, take steer but do not see all feedback as required, find pragmatic balance`,
        parent: "opus",
        systemPrompt: [communicationPrompts.agent, botlakePrompt, agentBrief].join("\n"),
      },
    ],

    prose: [
      {
        doc: `Dedicated prose writer/editor/reviewer. Do not allow other agents to make large prose based changes`,
        parent: "opus",
        systemPrompt: [communicationPrompts.agent, botlakePrompt, agentBrief].join("\n"),
      },
      {
        doc: `Dedicated prose writer/editor/reviewer. Do not allow other agents to make large prose based changes`,
        parent: "astra",
        systemPrompt: [communicationPrompts.agent, botlakePrompt, agentBrief].join("\n"),
      },
    ],

    worker: [
      {
        doc: `Primary worker agent to recieve bounded work as delegate`,
        parent: "sonnet",
        systemPrompt: [communicationPrompts.agent, botlakePrompt, agentBrief].join("\n"),
      },
      {
        doc: `Primary worker agent to recieve bounded work as delegate`,
        parent: "sol",
        systemPrompt: [communicationPrompts.agent, botlakePrompt, agentBrief].join("\n"),
      },
    ],

    grunt: [
      {
        doc: `Mechanical implementation, exploration and context-heavy file/log searching`,
        parent: "deepseek",
        systemPrompt: [communicationPrompts.agent, botlakePrompt].join("\n"),
      },
      {
        doc: `Mechanical implementation, exploration and context-heavy file/log searching`,
        parent: "haiku",
        systemPrompt: [communicationPrompts.agent, botlakePrompt].join("\n"),
      },
      {
        doc: `Mechanical implementation, exploration and context-heavy file/log searching`,
        parent: "luna",
        systemPrompt: [communicationPrompts.agent, botlakePrompt].join("\n"),
      },
    ],
  },
} satisfies AgentConfig;
