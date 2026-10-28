import { q, type Extension } from "@botlake/core";

import { registerAgent } from "./agent.ts";
import { Agents, type AgentOptions } from "./runs.ts";

export { agentConfigSchema, agentConfigJsonSchema } from "./catalog.ts";

export type { Seat, Alias, Condition, AgentConfig } from "./catalog.ts";

export { Agents } from "./runs.ts";

export type { AgentOptions, StartRun } from "./runs.ts";

export type { SessionContext, SystemPrompt } from "./prompt.ts";

export type { Audience } from "@botlake/native-session";

export { provider } from "./providers/index.ts";

export type {
  Provider,
  ProviderName,
  ProviderSettings,
  ProviderRun,
  LaunchPlan,
  Outcome,
} from "./providers/contract.ts";

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
      ctx.registerQuery("agent-run-settled", {
        description: "Managed run with settled custody, regardless of execution success",
        params: ["runId"],
        where: q.and(
          q.eq("id", q.param("runId")),
          q.eq(q.attr("agent/run"), true),
          q.eq(q.attr("agent/settled"), true),
        ),
      });
      ctx.resource({ start: () => service.startResource(), stop: () => service.stop() });
      registerAgent(ctx, service);
    },
  };
}

export default agents();
