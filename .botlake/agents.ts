import { harnesses } from "@botlake/extension-harnesses";

import { flagNames } from "./flags.ts";

export default harnesses({
  aliases: {
    deepseek: {
      doc: `DeepSeek V4.1 Flash. Fast, inexpensive coding for well-scoped acceptance criteria and established patterns. Unavailable while ${flagNames.seatAllowChina} is false.`,
      parent: "pi",
      model: "deepseek/deepseek-flash",
      effort: "max",
      when: flagNames.seatAllowChina,
    },
    luna: {
      doc: "GPT-5.6 Luna. Implementation details, scouting and tightly scoped delegated tasks. Give explicit success criteria.",
      parent: "pi",
      model: "openai-codex/gpt-5.6-luna",
      effort: "xhigh",
      when: flagNames.modelOpenai,
    },
    opus: {
      doc: "Claude Opus. Greenfield features, API design and critical seams. Keep independent review for authored changes.",
      parent: "claude",
      model: "opus",
      effort: "low",
      when: flagNames.modelAnthropic,
    },
    fable: {
      doc: "Claude Fable. Extreme diagnosis, top-level coordination and user-facing prose where writing is the product.",
      parent: "claude",
      model: "claude-fable-5",
      effort: "high",
      when: flagNames.modelAnthropic,
    },
    astra: {
      doc: "GPT-6 Astra. Extreme diagnosis, top-level coordination, architecture and high-stakes user-facing prose.",
      parent: "pi",
      model: "openai-codex/gpt-6-astra",
      effort: "high",
      when: flagNames.modelOpenai,
    },
    sol: {
      doc: "GPT-5.6 Sol. Complex implementation, hostile-environment debugging and delegated coordination.",
      parent: "pi",
      model: "openai-codex/gpt-5.6-sol",
      effort: "low",
      when: flagNames.modelOpenai,
    },
    terra: {
      doc: "GPT-5.6 Terra. Well-defined, single-concern review and validation on clean checkouts.",
      parent: "pi",
      model: "openai-codex/gpt-5.6-terra",
      effort: "high",
      when: flagNames.modelOpenai,
    },
    grok: {
      doc: "Grok. Greenfield implementation, API design and critical code review.",
      parent: "cursor",
      model: "cursor-grok-4.6",
      effort: "high",
      fast: true,
      when: flagNames.modelXai,
    },
    oracle: {
      doc: "Default seat for high-stakes guidance, diagnosis and architecture.",
      parent: "astra",
      effort: "high",
    },
    reviewer: [
      { doc: "Default targeted review seat: prefer Sol.", parent: "sol" },
      { doc: "Targeted review fallback: Opus when Sol is unavailable.", parent: "opus" },
    ],
    grunt: [
      {
        doc: "Mechanical implementation, exploration and context-heavy file/log searching. Prefer DeepSeek.",
        parent: "deepseek",
      },
      {
        doc: "Mechanical implementation, exploration and context-heavy file/log searching. Fall back to Luna.",
        parent: "luna",
      },
    ],
    tui: {
      doc: "Primary user seat, using Sol at low effort. Managed launches are headless, not interactive.",
      parent: "sol",
      effort: "low",
    },
  },
});
