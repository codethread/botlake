import { test, expect } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { install, system } from "./fixtures/system.ts";

const catalog = z.array(z.object({ name: z.string() }));

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
    expect(catalog.parse(await host.bl("bare", "help", {}))).toEqual([{ name: "bins" }]);
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
        ...z.record(z.string(), z.unknown()).parse(await manifest.json()),
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

    const board = await host.workspace("board", ["@botlake/extension-kanban"]);
    expect(await host.botlake(["lake", "start", "--workspace", board], false)).toContain(
      "requires explicitly selected identity",
    );
    await Bun.write(
      join(board, ".botlake/package.json"),
      JSON.stringify({
        botlake: {
          name: "board",
          extensions: ["@botlake/extension-kanban", "@botlake/extension-identity"],
        },
      }),
    );
    await host.botlake(["lake", "start", "--workspace", board]);
    expect(
      catalog
        .parse(await host.bl("board", "help", {}))
        .map((op) => op.name)
        .toSorted(),
    ).toEqual(["bins", "identity", "kanban", "kanban-export"]);
    expect(
      z
        .object({ title: z.string() })
        .parse(await host.bl("board", "kanban", { command: "add", title: "No Batteries" })).title,
    ).toBe("No Batteries");

    const agents = await host.workspace("configured", [
      "@botlake/extension-identity",
      "@botlake/extension-flags",
      "./agents.ts",
      "@botlake/extension-cron",
    ]);
    await Bun.write(
      join(agents, "harnesses.json"),
      JSON.stringify({ aliases: { worker: { provider: "codex" } } }),
    );
    await Bun.write(
      join(agents, "agents.ts"),
      `import { harnesses, harnessConfigSchema } from "@botlake/extension-harnesses";
import config from "./harnesses.json";
export default harnesses(harnessConfigSchema.parse(config));`,
    );
    await host.botlake(["lake", "start", "--workspace", agents]);
    expect(
      z
        .object({ aliases: z.record(z.string(), z.unknown()) })
        .parse(await host.bl("configured", "agent", { command: "catalog" })).aliases,
    ).toHaveProperty("worker");
    expect(
      z
        .object({ providers: z.array(z.string()) })
        .parse(await host.bl("configured", "agent", { command: "catalog" })).providers,
    ).toEqual(["codex", "pi", "claude", "cursor"]);
    expect(await host.bl("configured", "cron", { command: "status" })).toEqual([]);

    const shorthand = await host.workspace("shorthand", ["batteries"]);
    expect(await host.botlake(["lake", "start", "--workspace", shorthand], false)).toContain(
      "batteries",
    );
  } finally {
    await host.close();
  }
}, 60000);
