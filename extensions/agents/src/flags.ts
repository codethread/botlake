import { flags } from "@botlake/extension-flags";

export const agentFlags = flags({
  codex: {
    name: "agent/codex",
    description: "Allow the Codex provider for new agent runs.",
    default: false,
  },
  pi: {
    name: "agent/pi",
    description: "Allow the Pi provider for new agent runs.",
    default: false,
  },
  claude: {
    name: "agent/claude",
    description: "Allow the Claude provider for new agent runs.",
    default: false,
  },
});
