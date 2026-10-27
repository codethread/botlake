import { agents } from "@botlake/extension-agents";

import { flagNames } from "./flags.ts";

const workPrompt = [
  "This project uses Botlake for tasks and agent runs.",
  "Before tracking work, run `bl prime kanban` once per session.",
];

const delegationPrompt = [
  "Prefer Botlake for delegation unless the user requests native subagents.",
  "Before delegating, run `bl prime agent` once per session.",
];

export default agents({
  unmanaged: { systemPrompt: [...workPrompt, ...delegationPrompt].join("\n") },
  aliases: {
    deepseek: {
      doc: `DeepSeek V4.1 Flash. Fast, inexpensive coding for well-scoped acceptance
        criteria and established patterns. Unavailable while
        ${flagNames.seatAllowChina} is false.`,
      parent: "pi",
      model: "deepseek/deepseek-flash",
      effort: "max",
      when: flagNames.seatAllowChina,
      systemPrompt: [...workPrompt, ...delegationPrompt].join("\n"),
    },
    luna: {
      doc: `GPT-5.6 Luna. Implementation details, scouting and tightly scoped
        delegated tasks. Give explicit success criteria.`,
      parent: "pi",
      model: "openai-codex/gpt-5.6-luna",
      effort: "xhigh",
      when: flagNames.modelOpenai,
      systemPrompt: workPrompt.join("\n"),
    },
    opus: {
      doc: `Claude Opus. Greenfield features, API design and critical seams. Keep
        independent review for authored changes.`,
      parent: "claude",
      model: "opus",
      effort: "low",
      when: flagNames.modelAnthropic,
      systemPrompt: [...workPrompt, ...delegationPrompt].join("\n"),
    },
    fable: {
      doc: `Claude Fable. Extreme diagnosis, top-level coordination and user-facing
        prose where writing is the product.`,
      parent: "claude",
      model: "claude-fable-5",
      effort: "high",
      when: flagNames.modelAnthropic,
      systemPrompt: [...workPrompt, ...delegationPrompt].join("\n"),
    },
    astra: {
      doc: `GPT-6 Astra. Extreme diagnosis, top-level coordination, architecture and
        high-stakes user-facing prose.`,
      parent: "pi",
      model: "openai-codex/gpt-6-astra",
      effort: "high",
      when: flagNames.modelOpenai,
      systemPrompt: [...workPrompt, ...delegationPrompt].join("\n"),
    },
    sol: {
      doc: `GPT-5.6 Sol. Complex implementation, hostile-environment debugging and
        delegated coordination.`,
      parent: "pi",
      model: "openai-codex/gpt-5.6-sol",
      effort: "low",
      when: flagNames.modelOpenai,
      systemPrompt: [...workPrompt, ...delegationPrompt].join("\n"),
    },
    terra: {
      doc: `GPT-5.6 Terra. Well-defined, single-concern review and validation on
        clean checkouts.`,
      parent: "pi",
      model: "openai-codex/gpt-5.6-terra",
      effort: "high",
      when: flagNames.modelOpenai,
      systemPrompt: [...workPrompt, ...delegationPrompt].join("\n"),
    },
    oracle: {
      doc: `Default seat for high-stakes guidance, diagnosis and architecture.`,
      parent: "astra",
      effort: "high",
      systemPrompt: [...workPrompt, ...delegationPrompt].join("\n"),
    },
    reviewer: [
      {
        doc: `Default targeted review seat: prefer Sol.`,
        parent: "sol",
        systemPrompt: [...workPrompt, ...delegationPrompt].join("\n"),
      },
      {
        doc: `Targeted review fallback: Opus when Sol is unavailable.`,
        parent: "opus",
        systemPrompt: [...workPrompt, ...delegationPrompt].join("\n"),
      },
    ],
    grunt: [
      {
        doc: `Mechanical implementation, exploration and context-heavy file/log
          searching. Prefer DeepSeek.`,
        parent: "deepseek",
        systemPrompt: [...workPrompt, ...delegationPrompt].join("\n"),
      },
      {
        doc: `Mechanical implementation, exploration and context-heavy file/log
          searching. Fall back to Luna.`,
        parent: "luna",
        systemPrompt: workPrompt.join("\n"),
      },
    ],
    tui: {
      doc: `Primary user seat, using Sol at low effort. Managed launches are
        headless, not interactive.`,
      parent: "sol",
      effort: "low",
      systemPrompt: [...workPrompt, ...delegationPrompt].join("\n"),
    },
  },
});
