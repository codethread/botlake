import { agents, type SessionContext } from "@botlake/extension-agents";

import { flagNames } from "./flags.ts";

const workPrompt = [
  "This project uses Botlake for tasks and agent runs.",
  "Before tracking work, run `bl prime kanban` once per session.",
];

const delegationPrompt = [
  "Prefer Botlake for delegation unless the user requests native subagents.",
  "Before delegating, run `bl prime agent` once per session.",
];

function communicationPrompt({ audience }: SessionContext): string {
  if (audience === "human")
    return [
      "Communicate efficiently. Be concise, but include assumptions, actions, and next steps when they matter.",
      "Use fenced mermaid blocks when a visual hierarchy improves pedagogy, but keep syntax minimal (the harness will only render boxes, text and arrows; no color).",
      "Always print file paths in vimgrep format, absolute from the git root (for example, `src/file.txt:42`), keeping content separate in fenced blocks.",
    ].join("\n");

  if (audience === "agent")
    return [
      "The user you are communicating with is another agent, so be clear and informative.",
      "The user only has access to your response, not any tool calls, so provide all relevant information in your response.",
    ].join("\n");

  return [
    "Communicate clearly and informatively, including assumptions, actions, and next steps when they matter.",
    "Do not assume whether the recipient is a human or an agent.",
  ].join("\n");
}

function systemPrompt(canDelegate: boolean): (context: SessionContext) => string {
  return (context) =>
    [communicationPrompt(context), ...workPrompt, ...(canDelegate ? delegationPrompt : [])].join(
      "\n",
    );
}

export default agents({
  unmanaged: { systemPrompt: systemPrompt(true) },
  aliases: {
    deepseek: {
      doc: `DeepSeek V4.1 Flash. Fast, inexpensive coding for well-scoped acceptance
        criteria and established patterns. Unavailable while
        ${flagNames.seatAllowChina} is false.`,
      parent: "pi",
      model: "deepseek/deepseek-flash",
      effort: "max",
      when: flagNames.seatAllowChina,
      systemPrompt: systemPrompt(true),
    },
    luna: {
      doc: `GPT-5.6 Luna. Implementation details, scouting and tightly scoped
        delegated tasks. Give explicit success criteria.`,
      parent: "pi",
      model: "openai-codex/gpt-5.6-luna",
      effort: "xhigh",
      when: flagNames.modelOpenai,
      systemPrompt: systemPrompt(false),
    },
    opus: {
      doc: `Claude Opus. Greenfield features, API design and critical seams. Keep
        independent review for authored changes.`,
      parent: "claude",
      model: "opus",
      effort: "low",
      when: flagNames.modelAnthropic,
      systemPrompt: systemPrompt(true),
    },
    fable: {
      doc: `Claude Fable. Extreme diagnosis, top-level coordination and user-facing
        prose where writing is the product.`,
      parent: "claude",
      model: "claude-fable-5",
      effort: "high",
      when: flagNames.modelAnthropic,
      systemPrompt: systemPrompt(true),
    },
    astra: {
      doc: `GPT-6 Astra. Extreme diagnosis, top-level coordination, architecture and
        high-stakes user-facing prose.`,
      parent: "pi",
      model: "openai-codex/gpt-6-astra",
      effort: "high",
      when: flagNames.modelOpenai,
      systemPrompt: systemPrompt(true),
    },
    sol: {
      doc: `GPT-5.6 Sol. Complex implementation, hostile-environment debugging and
        delegated coordination.`,
      parent: "pi",
      model: "openai-codex/gpt-5.6-sol",
      effort: "low",
      when: flagNames.modelOpenai,
      systemPrompt: systemPrompt(true),
    },
    terra: {
      doc: `GPT-5.6 Terra. Well-defined, single-concern review and validation on
        clean checkouts.`,
      parent: "pi",
      model: "openai-codex/gpt-5.6-terra",
      effort: "high",
      when: flagNames.modelOpenai,
      systemPrompt: systemPrompt(true),
    },
    oracle: {
      doc: `Default seat for high-stakes guidance, diagnosis and architecture.`,
      parent: "astra",
      effort: "high",
      systemPrompt: systemPrompt(true),
    },
    reviewer: [
      {
        doc: `Default targeted review seat: prefer Sol.`,
        parent: "sol",
        systemPrompt: systemPrompt(true),
      },
      {
        doc: `Targeted review fallback: Opus when Sol is unavailable.`,
        parent: "opus",
        systemPrompt: systemPrompt(true),
      },
    ],
    grunt: [
      {
        doc: `Mechanical implementation, exploration and context-heavy file/log
          searching. Prefer DeepSeek.`,
        parent: "deepseek",
        systemPrompt: systemPrompt(true),
      },
      {
        doc: `Mechanical implementation, exploration and context-heavy file/log
          searching. Fall back to Luna.`,
        parent: "luna",
        systemPrompt: systemPrompt(false),
      },
    ],
    tui: {
      doc: `Primary user seat, using Sol at low effort. Managed launches are
        headless, not interactive.`,
      parent: "sol",
      effort: "low",
      systemPrompt: systemPrompt(true),
    },
  },
});
