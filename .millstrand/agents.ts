import { harnesses } from "@millstrand/spool-harnesses";

export default harnesses({
  aliases: {
    deepseek: {
      doc: "DeepSeek V4.1 Flash. Fast, inexpensive coding for well-scoped acceptance criteria and established patterns. Unavailable while seat/allow-china is false.",
      parent: "pi",
      model: "deepseek/deepseek-flash",
      effort: "max",
      when: "seat/allow-china",
    },
    luna: {
      doc: "GPT-5.6 Luna. Implementation details, scouting and tightly scoped delegated tasks. Give explicit success criteria.",
      parent: "pi",
      model: "openai-codex/gpt-5.6-luna",
      effort: "xhigh",
      when: "model/openai",
    },
    opus: {
      doc: "Claude Opus. Greenfield features, API design and critical seams. Keep independent review for authored changes.",
      parent: "claude",
      model: "opus",
      effort: "low",
      when: "model/anthropic",
    },
    fable: {
      doc: "Claude Fable. Extreme diagnosis, top-level coordination and user-facing prose where writing is the product.",
      parent: "claude",
      model: "claude-fable-5",
      effort: "high",
      when: "model/anthropic",
    },
    astra: {
      doc: "GPT-6 Astra. Extreme diagnosis, top-level coordination, architecture and high-stakes user-facing prose.",
      parent: "pi",
      model: "openai-codex/gpt-6-astra",
      effort: "high",
      when: "model/openai",
    },
    sol: {
      doc: "GPT-5.6 Sol. Complex implementation, hostile-environment debugging and delegated coordination.",
      parent: "pi",
      model: "openai-codex/gpt-5.6-sol",
      effort: "low",
      when: "model/openai",
    },
    terra: {
      doc: "GPT-5.6 Terra. Well-defined, single-concern review and validation on clean checkouts.",
      parent: "pi",
      model: "openai-codex/gpt-5.6-terra",
      effort: "high",
      when: "model/openai",
    },
    grok: {
      doc: "Grok. Greenfield implementation, API design and critical code review.",
      parent: "cursor",
      model: "cursor-grok-4.6",
      effort: "high",
      fast: true,
      when: "model/xai",
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
      doc: "Primary user seat, using Sol at low effort. Managed launches in this port are headless, not interactive.",
      parent: "sol",
      effort: "low",
    },
  },
});
