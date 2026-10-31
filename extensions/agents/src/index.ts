import { q, type Extension } from "@botlake/core";

import { registerAgent } from "./agent.ts";
import { registerAgentEvents } from "./events.ts";
import { agentAttributes, agentRunStateSchema } from "./node-model.ts";
import { Agents, type AgentOptions } from "./runs.ts";

export { agentConfigSchema, agentConfigJsonSchema } from "./catalog.ts";

export { agentFlags } from "./flags.ts";
export {
  agentAttributes,
  agentRelations,
  agentRunStateSchema,
  agentLifecycleSchema,
  agentLaunchSchema,
  agentActivityObservationSchema,
  runActivityAttributes,
  runActivityRelations,
  runActivityOptionsSchema,
} from "./node-model.ts";

export type { ActivityRead } from "./activity.ts";

export { agentsChanged } from "./events.ts";
export { resolveAssignmentRun, type AssignmentRun } from "./assignment-run.ts";
export {
  agentLiveness,
  agentLivenessSchema,
  readAgentLiveness,
  type AgentLiveness,
} from "./liveness.ts";

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
      registerAgentEvents(ctx);
      const service = new Agents(ctx, options);
      for (const state of agentRunStateSchema.options.filter((value) => value !== "external"))
        ctx.registerQuery(`agent-run-${state}`, {
          where: q.and(
            q.eq(q.attr(agentAttributes.run), true),
            q.eq(q.attr(agentAttributes.state), state),
          ),
          description: `Agent runs in ${state} state`,
        });
      ctx.registerQuery("agent-run-settled", {
        description: "Managed run with settled custody, regardless of execution success",
        params: ["runId"],
        where: q.and(
          q.eq("id", q.param("runId")),
          q.eq(q.attr(agentAttributes.run), true),
          q.eq(q.attr(agentAttributes.settled), true),
        ),
      });
      ctx.resource({ start: () => service.startResource(), stop: () => service.stop() });
      registerAgent(ctx, service);
    },
  };
}

export default agents();
