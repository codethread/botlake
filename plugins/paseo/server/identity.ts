import { execCommand } from "@getpaseo/plugin/server";
import { z } from "zod";

const page = z.object({
  nodes: z.array(z.object({ attributes: z.object({ "identity/id": z.string().min(1) }) })),
  total: z.number().int().max(1),
});

export async function registeredIdentity(cwd: string, provider: string, sessionId: string) {
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
