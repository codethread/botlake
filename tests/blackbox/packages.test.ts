import { test, expect } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { install, system } from "./fixtures/system.ts";

const catalog = z.compile(z.array(z.object({ name: z.string() })));
const providers = z.compile(z.object({ providers: z.array(z.string()) }));
const workItem = z.compile(
  z.object({ id: z.string(), kind: z.enum(["task", "group"]), state: z.string() }),
);
const workDetail = z.compile(z.object({ item: z.object({ title: z.string() }) }));

test("packed core runs alone; installed extensions require explicit selection and own their configuration", async () => {
  const host = await system();
  try {
    const bare = join(host.dir, "bare");
    await mkdir(join(bare, ".botlake"), { recursive: true });
    await Bun.write(
      join(bare, ".botlake/package.json"),
      '{"name":"@example/not-the-lake-name","private":true,"botlake":{}}',
    );
    await host.botlake(["lake", "start", "--workspace", bare]);
    expect(catalog.parse(await host.bl("bare", "help", {}))).toEqual([
      { name: "bins" },
      { name: "events" },
    ]);
    expect(await host.bl("bare", "list", {}, false)).toContain("Unknown op");
    expect(await Bun.file(join(bare, ".botlake/world.db")).exists()).toBe(true);

    await install(
      join(bare, ".botlake"),
      Object.fromEntries(
        Object.entries(host.packages).filter(
          ([name]) => name === "@botlake/core" || name === "@botlake/extension-batteries",
        ),
      ),
    );
    const manifest = Bun.file(join(bare, ".botlake/package.json"));
    await Bun.write(
      manifest,
      JSON.stringify({
        ...z.compile(z.record(z.string(), z.unknown())).parse(await manifest.json()),
        botlake: { extensions: ["@botlake/extension-batteries"] },
      }),
    );
    await host.botlake(["lake", "restart", "--workspace", "bare"]);
    expect(
      await host.cli(["--workspace", "bare", "add", "Configuration-local dependency"]),
    ).toMatchObject({ title: "Configuration-local dependency" });
    expect(await host.bl("bare", "list", {})).toMatchObject([
      { title: "Configuration-local dependency" },
    ]);

    const board = await host.workspace("board", ["@botlake/extension-work"]);
    expect(await host.botlake(["lake", "start", "--workspace", board], false)).toContain(
      "requires explicitly selected identity",
    );
    await Bun.write(
      join(board, ".botlake/package.json"),
      JSON.stringify({
        botlake: {
          name: "board",
          extensions: ["@botlake/extension-work", "@botlake/extension-identity"],
        },
      }),
    );
    await host.botlake(["lake", "start", "--workspace", board]);
    expect(
      catalog
        .parse(await host.bl("board", "help", {}))
        .map((op) => op.name)
        .toSorted(),
    ).toEqual(["bins", "events", "identity", "work"]);
    const task = workItem.parse(
      await host.bl("board", "work", { command: "create", title: "No Batteries" }),
    );
    expect(
      workDetail.parse(await host.bl("board", "work", { command: "show", id: task.id })).item.title,
    ).toBe("No Batteries");

    const agents = await host.workspace("configured", [
      "@botlake/extension-identity",
      "@botlake/extension-flags",
      "./agents.ts",
      "@botlake/extension-cron",
    ]);
    await Bun.write(
      join(agents, "agents.json"),
      JSON.stringify({ aliases: { worker: { provider: "codex" } } }),
    );
    await Bun.write(
      join(agents, "agents.ts"),
      `import { agents, agentConfigSchema } from "@botlake/extension-agents";
import config from "./agents.json";
export default agents(agentConfigSchema.parse(config));`,
    );
    await host.botlake(["lake", "start", "--workspace", agents]);
    expect(
      providers.parse(await host.bl("configured", "agent", { command: "catalog" })).providers,
    ).toEqual([]);
    expect(
      catalog.parse(await host.bl("configured", "help", {})).map((op) => op.name),
    ).not.toContain("work-agent");
    await Bun.write(
      join(agents, "flags.ts"),
      `import { agentFlags } from "@botlake/extension-agents";
import { configureFlags } from "@botlake/extension-flags";
export default configureFlags([[agentFlags.codex, true], [agentFlags.pi, true], [agentFlags.claude, true]]);`,
    );
    await Bun.write(
      join(agents, "work-agents.ts"),
      `import { workAgents } from "@botlake/extension-work-agents";
export default workAgents({ checkIntervalMs: 60000 });`,
    );
    await Bun.write(
      join(agents, ".botlake/package.json"),
      JSON.stringify({
        botlake: {
          name: "configured",
          extensions: [
            "@botlake/extension-identity",
            "./flags.ts",
            "./agents.ts",
            "@botlake/extension-work",
            "./work-agents.ts",
            "@botlake/extension-cron",
          ],
        },
      }),
    );
    await host.botlake(["lake", "restart", "--workspace", agents]);
    expect(
      catalog
        .parse(await host.bl("configured", "help", {}))
        .map((op) => op.name)
        .toSorted(),
    ).toEqual(["agent", "bins", "cron", "events", "flag", "identity", "work", "work-agent"]);
    expect(
      z
        .compile(z.object({ aliases: z.record(z.string(), z.unknown()) }))
        .parse(await host.bl("configured", "agent", { command: "catalog" })).aliases,
    ).toHaveProperty("worker");
    expect(
      providers.parse(await host.bl("configured", "agent", { command: "catalog" })).providers,
    ).toEqual(["codex", "pi", "claude"]);
    expect(await host.bl("configured", "cron", { command: "status" })).toEqual([]);

    const shorthand = await host.workspace("shorthand", ["batteries"]);
    expect(await host.botlake(["lake", "start", "--workspace", shorthand], false)).toContain(
      "batteries",
    );
  } finally {
    await host.close();
  }
}, 60000);
