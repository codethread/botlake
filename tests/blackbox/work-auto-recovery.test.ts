import { expect, test } from "bun:test";

import { source } from "./fixtures/system.ts";

test("Work Auto bounded recovery composes custody, Mail and one-shot Oracle across disposable and packed lakes", async () => {
  const child = Bun.spawn(["bun", "scripts/work-auto-bot-smoke.ts"], {
    cwd: source,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(code, `${stderr}\n${stdout}`).toBe(0);
  expect(stdout).toContain("work-auto-bot smoke verified");
}, 60_000);
