import { test, expect } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { install, system } from "./fixtures/system.ts";

const catalog = z.array(z.object({ name: z.string() }));

test("packed core runs alone; installed spools require explicit selection and own their configuration", async () => {
  const host = await system();
  try {
    const bare = join(host.dir, "bare");
    await mkdir(join(bare, ".millstrand"), { recursive: true });
    await Bun.write(join(bare, ".millstrand/config.json"), '{"name":"bare"}');
    await host.mill(["weaver", "start", "--workspace", bare]);
    expect(catalog.parse(await host.strand("bare", "help", {}))).toEqual([{ name: "bins" }]);
    expect(await host.strand("bare", "list", {}, false)).toContain("Unknown op");
    expect(await Bun.file(join(bare, ".millstrand/world.db")).exists()).toBe(true);

    await install(
      join(bare, ".millstrand"),
      Object.fromEntries(
        Object.entries(host.packages).filter(
          ([name]) => name === "@millstrand/core" || name === "@millstrand/spool-batteries",
        ),
      ),
    );
    await Bun.write(
      join(bare, ".millstrand/config.json"),
      JSON.stringify({ name: "bare", spools: ["@millstrand/spool-batteries"] }),
    );
    await host.mill(["weaver", "restart", "--workspace", "bare"]);
    expect(
      await host.cli(["--workspace", "bare", "add", "Configuration-local dependency"]),
    ).toMatchObject({ title: "Configuration-local dependency" });
    expect(await host.strand("bare", "list", {})).toMatchObject([
      { title: "Configuration-local dependency" },
    ]);

    const board = await host.workspace("board", ["@millstrand/spool-kanban"]);
    expect(await host.mill(["weaver", "start", "--workspace", board], false)).toContain(
      "requires explicitly selected identity",
    );
    await Bun.write(
      join(board, ".millstrand/config.json"),
      JSON.stringify({
        name: "board",
        spools: ["@millstrand/spool-kanban", "@millstrand/spool-identity"],
      }),
    );
    await host.mill(["weaver", "start", "--workspace", board]);
    expect(
      catalog
        .parse(await host.strand("board", "help", {}))
        .map((op) => op.name)
        .toSorted(),
    ).toEqual(["bins", "identity", "kanban", "kanban-export"]);
    expect(
      z
        .object({ title: z.string() })
        .parse(await host.strand("board", "kanban", { command: "add", title: "No Batteries" }))
        .title,
    ).toBe("No Batteries");

    const agents = await host.workspace("configured", [
      "@millstrand/spool-identity",
      "./agents.ts",
      "@millstrand/spool-cron",
    ]);
    await Bun.write(
      join(agents, "harnesses.json"),
      JSON.stringify({ aliases: { worker: { provider: "codex" } } }),
    );
    await Bun.write(
      join(agents, "agents.ts"),
      `import { harnesses, harnessConfigSchema } from "@millstrand/spool-harnesses";
import config from "./harnesses.json";
export default harnesses(harnessConfigSchema.parse(config));`,
    );
    await host.mill(["weaver", "start", "--workspace", agents]);
    expect(
      z
        .object({ aliases: z.record(z.string(), z.unknown()) })
        .parse(await host.strand("configured", "agent", { command: "catalog" })).aliases,
    ).toHaveProperty("worker");
    expect(
      z
        .object({ providers: z.array(z.string()) })
        .parse(await host.strand("configured", "agent", { command: "catalog" })).providers,
    ).toEqual(["codex", "pi", "claude", "cursor"]);
    expect(await host.strand("configured", "cron", { command: "status" })).toEqual([]);

    const shorthand = await host.workspace("shorthand", ["batteries"]);
    expect(await host.mill(["weaver", "start", "--workspace", shorthand], false)).toContain(
      "batteries",
    );
  } finally {
    await host.close();
  }
}, 60000);
