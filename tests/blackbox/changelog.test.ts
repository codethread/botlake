import { test, expect } from "bun:test";
import { join } from "node:path";

import { z } from "zod";

const root = join(import.meta.dirname, "../..");
const changelogPageSchema = z.object({
  ok: z.literal(true),
  kind: z.literal("changelog"),
  tool: z.literal("Botlake CLI"),
  installedVersion: z.string().regex(/^\d+\.\d+\.\d+$/u),
  releases: z.array(z.unknown()),
  total: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
});

test("Botlake CLI changelog query is machine-readable and the generated file stays in sync", async () => {
  const query = await runChangelogCommand(["changelog", "--", "--version", "0.2.0", "--json"]);
  expect(query.exitCode).toBe(0);
  expect(query.stderr).toBe("");
  expect(changelogPageSchema.parse(JSON.parse(query.stdout))).toMatchObject({
    ok: true,
    kind: "changelog",
    tool: "Botlake CLI",
    installedVersion: "0.2.0",
  });

  const sync = await runChangelogCommand(["changelog:check"]);
  expect(sync.exitCode).toBe(0);
  expect(sync.stdout).toContain("cli/CHANGELOG.md matches cli/changelog.json.");
});

async function runChangelogCommand(arguments_: string[]): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const child = Bun.spawn(["bun", "run", "--silent", ...arguments_], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}
