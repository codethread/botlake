import { flags } from "@botlake/extension-flags";

export default flags({
  "harness/claude": {
    description: "Allow the Claude provider for new agent runs.",
    value: false,
  },
  "harness/cursor": {
    description: "Allow the Cursor provider for new agent runs.",
    value: false,
  },
  "seat/allow-china": {
    description: "Allow China-hosted model seats, including DeepSeek.",
    value: true,
  },
  "model/openai": {
    description: "Enable seats gated on OpenAI models.",
    value: true,
  },
  "model/anthropic": {
    description: "Enable seats gated on Anthropic models; the provider must also be enabled.",
    value: true,
  },
  "model/xai": {
    description: "Enable seats gated on xAI models; the provider must also be enabled.",
    value: true,
  },
});
