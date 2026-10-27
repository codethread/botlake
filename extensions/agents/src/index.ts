import { q, type Extension } from "@botlake/core";

import { registerAgent } from "./agent.ts";
import { Agents, type AgentOptions } from "./runs.ts";

export function agents(options: AgentOptions = {}): Extension {
  return {
    name: "agents",
    requires: ["identity", "flags"],
    activate(ctx) {
      const service = new Agents(ctx, options);
      for (const state of ["ready", "running", "stopped", "failed"])
        ctx.registerQuery(`agent-run-${state}`, {
          where: q.and(q.eq(q.attr("agent/run"), true), q.eq(q.attr("agent/state"), state)),
          description: `Agent runs in ${state} state`,
        });
      ctx.resource({ start: () => service.startResource(), stop: () => service.stop() });
      registerAgent(ctx, service);
    },
  };
}

export default agents();

export { agentConfigSchema, agentConfigJsonSchema } from "./catalog.ts";

export type { Seat, Alias, Condition, AgentConfig } from "./catalog.ts";
export { Agents } from "./runs.ts";

export type { AgentOptions, StartRun } from "./runs.ts";
export type { SessionContext, SystemPrompt } from "./prompt.ts";
export { provider } from "./providers/index.ts";

export type {
  Provider,
  ProviderName,
  ProviderSettings,
  ProviderRun,
  LaunchPlan,
  Outcome,
} from "./providers/contract.ts";
