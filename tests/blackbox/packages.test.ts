import { test, expect } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { coreVersion } from "@botlake/core";
import { z } from "zod";

import { install, system } from "./fixtures/system.ts";

const catalog = z.compile(z.array(z.object({ name: z.string() })));
const providers = z.compile(z.object({ providers: z.array(z.string()) }));
const workItem = z.compile(
  z.object({ id: z.string(), kind: z.enum(["task", "group"]), state: z.string() }),
);
const workDetail = z.compile(z.object({ item: z.object({ title: z.string() }) }));

test("lake start --install installs before activation and leaves an active lake alone", async () => {
  const host = await system();
  try {
    const workspace = join(host.dir, "install");
    const config = join(workspace, ".botlake");
    const manifest = join(config, "package.json");
    await mkdir(config, { recursive: true });
    await Bun.write(
      manifest,
      JSON.stringify({
        private: true,
        dependencies: { "install-fixture": "file:./fixture" },
        botlake: { extensions: ["install-fixture"] },
      }),
    );

    const start = ["lake", "start", "--install", "--workspace"];
    expect(await host.botlake([...start, workspace], false)).toContain("bun install in");
    expect(await host.botlake(["lake", "list"])).toEqual([]);
    expect(await Bun.file(join(config, "world.db")).exists()).toBe(false);

    const fixture = join(config, "fixture");
    await Bun.write(
      join(fixture, "package.json"),
      '{"name":"install-fixture","version":"1.0.0","type":"module","exports":"./index.ts"}',
    );
    await Bun.write(
      join(fixture, "index.ts"),
      'export default { name: "installed", activate() {} };',
    );
    expect(await host.botlake([...start, workspace])).toMatchObject({ name: "install" });
    expect(await host.botlake(["lake", "info", "--workspace", "install"])).toMatchObject({
      extensions: [{ name: "installed" }],
    });
    expect(await Bun.file(join(config, "world.db")).exists()).toBe(true);

    await Bun.write(manifest, '{"botlake":{},"dependencies":{"missing":"file:./missing"}}');
    expect(await host.botlake([...start, "install"])).toMatchObject({ name: "install" });
  } finally {
    await host.close();
  }
}, 60000);

test("lake minimumCore uses the supervisor's loaded core and reports compatibility versions", async () => {
  const host = await system();
  try {
    const workspace = await host.workspace("compatibility", []);
    const manifest = join(workspace, ".botlake/package.json");
    const installedCoreManifest = join(workspace, "node_modules/@botlake/core/package.json");
    const installedCore = z
      .compile(z.record(z.string(), z.unknown()))
      .parse(await Bun.file(installedCoreManifest).json());
    await Bun.write(installedCoreManifest, JSON.stringify({ ...installedCore, version: "9.0.0" }));
    await Bun.write(
      manifest,
      JSON.stringify({ botlake: { name: "compatibility", minimumCore: "9999.0.0" } }),
    );

    const incompatible = await host.botlake(["lake", "start", "--workspace", workspace], false);
    expect(incompatible).toContain(
      `Lake requires @botlake/core 9999.0.0 or newer, but the running supervisor loaded ${coreVersion}`,
    );
    expect(incompatible).toContain("Upgrade the supervisor's @botlake/core package");
    expect(await host.botlake(["lake", "list"])).toEqual([]);

    await Bun.write(
      manifest,
      JSON.stringify({ botlake: { name: "compatibility", minimumCore: coreVersion } }),
    );
    await host.botlake(["lake", "start", "--workspace", workspace]);
    expect(await host.botlake(["lake", "info", "--workspace", workspace])).toMatchObject({
      coreVersion,
      minimumCore: coreVersion,
    });
    expect(await host.botlake(["lake", "status", "--workspace", workspace])).toMatchObject({
      ready: true,
      coreVersion,
    });
    const cli = z.object({ cli_version: z.string() }).parse(await host.botlake(["--version"]));
    expect(await host.botlake(["status"])).toMatchObject({
      supervisorVersion: cli.cli_version,
      protocolVersion: 1,
      coreVersion,
    });
    expect(await host.botlake(["host-status"])).toMatchObject({ coreVersion });

    const primer = Bun.spawn(
      ["bun", "-e", 'import { brief } from "@botlake/core"; console.log(brief)'],
      {
        cwd: workspace,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [primerExit, primerOutput, primerError] = await Promise.all([
      primer.exited,
      new Response(primer.stdout).text(),
      new Response(primer.stderr).text(),
    ]);
    expect(primerExit, primerError).toBe(0);
    const documentationUrl = /Read (file:\/\/\S+) for core documentation/u.exec(primerOutput)?.[1];
    expect(documentationUrl).toBeDefined();
    if (documentationUrl === undefined) throw new Error(primerOutput);
    expect(fileURLToPath(documentationUrl)).toEndWith("@botlake/core/README.md");
    expect(await Bun.file(fileURLToPath(documentationUrl)).exists()).toBe(true);
  } finally {
    await host.close();
  }
}, 60000);

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
    expect(await host.bl("bare", "node", { command: "list" }, false)).toContain("Unknown op");
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
      await host.cli(["--workspace", "bare", "node", "add", "Configuration-local dependency"]),
    ).toMatchObject({ title: "Configuration-local dependency" });
    expect(await host.bl("bare", "node", { command: "list" })).toMatchObject({
      nodes: [{ title: "Configuration-local dependency" }],
      total: 1,
      nextOffset: null,
    });

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
    ).toEqual(["bins", "events", "gate", "identity", "work"]);
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
    ).toEqual([
      "agent",
      "bins",
      "cron",
      "events",
      "flag",
      "gate",
      "identity",
      "work",
      "work-agent",
    ]);
    expect(
      z
        .compile(z.object({ aliases: z.record(z.string(), z.unknown()) }))
        .parse(await host.bl("configured", "agent", { command: "catalog" })).aliases,
    ).toHaveProperty("worker");
    expect(
      providers.parse(await host.bl("configured", "agent", { command: "catalog" })).providers,
    ).toEqual(["codex", "pi", "claude"]);
    expect(await host.bl("configured", "cron", { command: "status" })).toEqual({
      items: [],
      total: 0,
      nextOffset: null,
    });

    const shorthand = await host.workspace("shorthand", ["batteries"]);
    expect(await host.botlake(["lake", "start", "--workspace", shorthand], false)).toContain(
      "batteries",
    );
  } finally {
    await host.close();
  }
}, 60000);
