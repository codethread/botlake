import type { PluginServerContext } from "@getpaseo/plugin/server";

import { registeredIdentity } from "./server/identity.ts";
import { lookup } from "./shared/lookup.ts";

export default function contribute(server: PluginServerContext) {
  server.handle(lookup, async ({ agentId }, { paseo }) => {
    const snapshot = await paseo.agents.ref(agentId).refresh();
    if (snapshot === null) throw new Error("Paseo agent not found");
    const { cwd, persistence } = snapshot.agent;
    if (persistence === null) return { status: "no-session" as const };
    const identity = await registeredIdentity(cwd, persistence.provider, persistence.sessionId);
    return identity === undefined
      ? { status: "not-registered" as const }
      : { status: "registered" as const, identity };
  });
  return () => {};
}
