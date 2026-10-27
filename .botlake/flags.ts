import { flags } from "@botlake/extension-flags";

export const flagNames = {
  harnessClaude: "harness/claude",
  harnessCursor: "harness/cursor",
  seatAllowChina: "seat/allow-china",
  modelOpenai: "model/openai",
  modelAnthropic: "model/anthropic",
  modelXai: "model/xai",
} as const;

export default flags({
  [flagNames.harnessClaude]: {
    description: "Allow the Claude provider for new agent runs.",
    value: false,
  },
  [flagNames.harnessCursor]: {
    description: "Allow the Cursor provider for new agent runs.",
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
  [flagNames.modelXai]: {
    description: "Enable seats gated on xAI models; the provider must also be enabled.",
    value: true,
  },
});
