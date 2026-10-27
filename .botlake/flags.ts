import { flags } from "@botlake/extension-flags";

export const flagNames = {
  agentClaude: "agent/claude",
  seatAllowChina: "seat/allow-china",
  modelOpenai: "model/openai",
  modelAnthropic: "model/anthropic",
} as const;

export default flags({
  [flagNames.agentClaude]: {
    description: "Allow the Claude provider for new agent runs.",
    value: false,
  },
  [flagNames.seatAllowChina]: {
    description: "Allow China-hosted model seats, including DeepSeek.",
    value: true,
  },
  [flagNames.modelOpenai]: {
    description: "Enable seats gated on OpenAI models.",
    value: true,
  },
  [flagNames.modelAnthropic]: {
    description: "Enable seats gated on Anthropic models; the provider must also be enabled.",
    value: true,
  },
});
