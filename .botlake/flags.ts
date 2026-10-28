import { agentFlags } from "@botlake/extension-agents";
import { configureFlags, flags } from "@botlake/extension-flags";

export const workspaceFlags = flags({
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

export default configureFlags([
  [agentFlags.codex, true],
  [agentFlags.pi, true],
  [agentFlags.claude, false],
  [workspaceFlags.deepseek, true],
  [workspaceFlags.fable, true],
]);
