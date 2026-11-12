import { expect, test } from "bun:test";
import { chmod } from "node:fs/promises";
import { dirname, join } from "node:path";

import { agentAttributes } from "@botlake/extension-agents";
import { z } from "zod";

import { system } from "./fixtures/system.ts";

const identifier = z.compile(z.object({ id: z.string() }));
const runSchema = z.compile(z.object({ attributes: z.record(z.string(), z.json()) }));
const launchSchema = z.compile(z.object({ command: z.array(z.string()) }));
const catalogSchema = z.compile(z.object({ providers: z.array(z.string()) }));

test("packed ct-config resolves co, cl and piw through PATH and preserves provider gates", async () => {
  const host = await system();
  try {
    const workspace = await host.workspace("ct-bins", [
      "@botlake/extension-batteries",
      "@botlake/extension-identity",
      "./flags.ts",
      "./references.ts",
      "./agents.ts",
    ]);
    for (const name of ["flags", "references", "agents"]) {
      await Bun.write(
        join(workspace, `${name}.ts`),
        `export { ${name} as default } from "@botlake/extension-ct-config";`,
      );
    }
    for (const [bin, provider] of [
      ["co", "codex"],
      ["cl", "claude"],
      ["piw", "pi"],
    ] as const) {
      const executable = join(dirname(host.blBin), bin);
      await Bun.write(
        executable,
        `#!/usr/bin/env bun
const provider = ${JSON.stringify(provider)};
const args = Bun.argv.slice(2);
const prompt = (await Bun.stdin.text()).trim();
if (!args.includes(provider === "codex" ? "--json" : "--print")) throw new Error("Missing native protocol args");
if (provider === "pi" && args[args.indexOf("--model") + 1] !== "openai-codex/gpt-6-luna") throw new Error("Missing configured Luna model");
const session = "fixture-" + crypto.randomUUID();
function emit(event: unknown) { console.log(JSON.stringify(event)); }
if (provider === "claude") emit({session_id: session, result: prompt});
else if (provider === "codex") {
  emit({type: "thread.started", thread_id: session});
  emit({type: "item.completed", item: {type: "agent_message", text: prompt}});
} else {
  emit({type: "session", id: session});
  emit({type: "message_end", message: {role: "assistant", content: [{type: "text", text: prompt}], stopReason: "stop"}});
}
`,
      );
      await chmod(executable, 0o755);
    }
    await host.botlake(["lake", "start", "--workspace", workspace]);
    expect(
      catalogSchema.parse(await host.bl(workspace, "agent", { command: "catalog" })).providers,
    ).toEqual(["codex", "pi"]);
    await host.bl(workspace, "flag", { command: "set", name: "agent/claude", value: true });
    expect(
      catalogSchema.parse(await host.bl(workspace, "agent", { command: "catalog" })).providers,
    ).toEqual(["codex", "pi", "claude"]);
    for (const [bin, provider, seat] of [
      ["co", "codex", "codex"],
      ["cl", "claude", "claude"],
      ["piw", "pi", "luna"],
    ] as const) {
      const { id } = identifier.parse(
        await host.bl(workspace, "agent", {
          command: "start",
          seat,
          cwd: workspace,
          prompt: `configured-${bin}`,
        }),
      );
      expect(
        await host.bl(workspace, "await", {
          query: "agent-run-settled",
          params: { runId: id },
          minCount: 1,
          timeoutSecs: 10,
        }),
      ).toMatchObject({ reason: "satisfied" });
      const run = runSchema.parse(await host.bl(workspace, "agent", { command: "show", id }));
      expect(run.attributes[agentAttributes.substatus]).toBe("completed");
      expect(run.attributes[agentAttributes.provider]).toBe(provider);
      expect(run.attributes[agentAttributes.result]).toBe(`configured-${bin}`);
      expect(run.attributes[agentAttributes.integration]).toBe("output");
      const launch = launchSchema.parse(run.attributes[agentAttributes.launch]);
      expect(launch.command).toContain(bin);
      expect(launch.command).not.toContain(join(dirname(host.blBin), bin));
    }
    await host.bl(workspace, "flag", { command: "set", name: "agent/pi", value: false });
    expect(await host.bl(workspace, "agent", { command: "catalog", name: "luna" })).toMatchObject({
      available: false,
    });
  } finally {
    await host.close();
  }
}, 60000);
