import { execCommand, type PluginServerContext } from "@getpaseo/plugin/server";
import { z } from "zod";

import { lookup } from "./shared/lookup.ts";

const page = z.object({
  nodes: z.array(z.object({ attributes: z.object({ "identity/id": z.string().min(1) }) })),
  total: z.number().int().max(1),
});

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

async function registeredIdentity(cwd: string, provider: string, sessionId: string) {
  const equals = (attr: string, value: string | boolean) => ({ op: "=", field: { attr }, value });
  const input = {
    command: "list",
    lean: false,
    limit: 1,
    where: {
      op: "and",
      args: [
        equals("identity/session", true),
        equals("identity/provider", provider),
        equals("identity/native-session-id", sessionId),
      ],
    },
  };
  // Route by the agent's Git common root, not the plugin process's lake.
  const env = { ...process.env };
  delete env["BL_WORKSPACE"];
  const { stdout } = await execCommand("bl", ["--json", "--input", JSON.stringify(input), "node"], {
    env,
    cwd,
    timeout: 5000,
  });
  return page.parse(JSON.parse(stdout)).nodes[0]?.attributes["identity/id"];
}
