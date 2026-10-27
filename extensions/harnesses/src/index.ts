import { q, type Extension } from "@botlake/core";

import { registerAgent } from "./agent.ts";
import { Harnesses, type HarnessOptions } from "./runs.ts";

export function harnesses(options: HarnessOptions = {}): Extension {
  return {
    name: "harnesses",
    requires: ["identity", "flags"],
    activate(ctx) {
      const service = new Harnesses(ctx, options);
      for (const state of ["ready", "running", "stopped", "failed"])
        ctx.registerQuery(`agent-run-${state}`, {
          where: q.and(q.eq(q.attr("harness/run"), true), q.eq(q.attr("harness/state"), state)),
          description: `Agent runs in ${state} state`,
        });
      ctx.resource({ start: () => service.startResource(), stop: () => service.stop() });
      registerAgent(ctx, service);
    },
  };
}

export default harnesses();

export { harnessConfigSchema, harnessConfigJsonSchema } from "./catalog.ts";

export type { Seat, Alias, Condition, HarnessConfig } from "./catalog.ts";
export { Harnesses } from "./runs.ts";

export type { HarnessOptions, StartRun } from "./runs.ts";
export { provider } from "./providers/index.ts";

export type {
  Provider,
  ProviderName,
  ProviderSettings,
  ProviderRun,
  LaunchPlan,
  Outcome,
} from "./providers/contract.ts";
