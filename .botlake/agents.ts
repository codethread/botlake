import { agents } from "@botlake/extension-agents";

import { workspaceFlags } from "./flags.ts";

const workPrompt = [
  "This project uses Botlake for tasks and agent runs.",
  "Before tracking work, run `bl prime kanban` once per session.",
].join("\n");

const delegationPrompt = [
  "Prefer Botlake for delegation unless the user requests native subagents.",
  "Before delegating, run `bl prime agent` once per session.",
].join("\n");

const communicationPrompts = {
  human: [
    "Communicate efficiently. Be concise, but include assumptions, actions, and next steps when they matter.",
    "Use fenced mermaid blocks when a visual hierarchy improves pedagogy, but keep syntax minimal (the harness will only render boxes, text and arrows; no color).",
    "Always print file paths in vimgrep format, absolute from the git root (for example, `src/file.txt:42`), keeping content separate in fenced blocks.",
  ].join("\n"),
  agent: [
    "The user you are communicating with is another agent, so be clear and informative.",
    "The user only has access to your response, not any tool calls, so provide all relevant information in your response.",
  ].join("\n"),
  unknown: [
    "Communicate clearly and informatively, including assumptions, actions, and next steps when they matter.",
    "Do not assume whether the recipient is a human or an agent.",
  ].join("\n"),
};

export default agents({
  unmanaged: {
    systemPrompt: ({ audience }) =>
      [communicationPrompts[audience], workPrompt, delegationPrompt].join("\n"),
  },
  aliases: {
    deepseek: {
      doc: `DeepSeek V4.1 Flash. Fast, inexpensive coding for well-scoped acceptance criteria and established patterns.`,
      parent: "pi",
      model: "deepseek/deepseek-flash",
      effort: "max",
      when: workspaceFlags.deepseek.name,
      systemPrompt: [communicationPrompts.agent, workPrompt].join("\n"),
    },
    luna: {
      doc: `GPT Luna. Implementation details, scouting and tightly scoped delegated tasks. Give explicit success criteria.`,
      parent: "pi",
      model: "openai-codex/gpt-6.1-luna",
      effort: "xhigh",
      systemPrompt: [communicationPrompts.agent, workPrompt].join("\n"),
    },
    opus: {
      doc: `Claude Opus. Greenfield features, API design and critical seams.`,
      parent: "claude",
      model: "opus",
      effort: "low",
      systemPrompt: [communicationPrompts.agent, workPrompt, delegationPrompt].join("\n"),
    },
    fable: {
      doc: `Claude Fable. Extreme diagnosis, top-level coordination and user-facing prose where writing is the product.`,
      parent: "claude",
      model: "claude-fable-5",
      effort: "high",
      when: workspaceFlags.fable.name,
      systemPrompt: [communicationPrompts.agent, workPrompt, delegationPrompt].join("\n"),
    },
    astra: {
      doc: `GPT-6 Astra. Extreme diagnosis, top-level coordination, architecture and
        high-stakes user-facing prose.`,
      parent: "pi",
      model: "openai-codex/gpt-6-astra",
      effort: "high",
      systemPrompt: [communicationPrompts.agent, workPrompt, delegationPrompt].join("\n"),
    },
    sol: {
      doc: `GPT-5.6 Sol. Complex implementation, hostile-environment debugging and
        delegated coordination.`,
      parent: "pi",
      model: "openai-codex/gpt-5.6-sol",
      effort: "low",
      systemPrompt: [communicationPrompts.agent, workPrompt, delegationPrompt].join("\n"),
    },
    terra: {
      doc: `GPT-5.6 Terra. Well-defined, single-concern review and validation on
        clean checkouts.`,
      parent: "pi",
      model: "openai-codex/gpt-5.6-terra",
      effort: "high",
      systemPrompt: [communicationPrompts.agent, workPrompt, delegationPrompt].join("\n"),
    },
    oracle: {
      doc: `Default seat for high-stakes guidance, diagnosis and architecture.`,
      parent: "astra",
      effort: "high",
      systemPrompt: [communicationPrompts.agent, workPrompt, delegationPrompt].join("\n"),
    },
    reviewer: [
      {
        doc: `Default targeted review seat: prefer Sol.`,
        parent: "sol",
        systemPrompt: [communicationPrompts.agent, workPrompt, delegationPrompt].join("\n"),
      },
      {
        doc: `Targeted review fallback: Opus when Sol is unavailable.`,
        parent: "opus",
        systemPrompt: [communicationPrompts.agent, workPrompt, delegationPrompt].join("\n"),
      },
    ],
    grunt: [
      {
        doc: `Mechanical implementation, exploration and context-heavy file/log
          searching. Prefer DeepSeek.`,
        parent: "deepseek",
        systemPrompt: [communicationPrompts.agent, workPrompt, delegationPrompt].join("\n"),
      },
      {
        doc: `Mechanical implementation, exploration and context-heavy file/log
          searching. Fall back to Luna.`,
        parent: "luna",
        systemPrompt: [communicationPrompts.agent, workPrompt].join("\n"),
      },
    ],
  },
});
