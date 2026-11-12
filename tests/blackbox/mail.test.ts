import { expect, test } from "bun:test";
import { join } from "node:path";

import { z } from "zod";

import { source, system } from "./fixtures/system.ts";

for (const script of ["smoke", "lifecycle-smoke"])
  test(`Mail ${script} passes disposable SQLite verification`, async () => {
    const child = Bun.spawn(["bun", `scripts/mail-graph/${script}.ts`], {
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
    expect(z.object({ passed: z.literal(true) }).parse(JSON.parse(stdout))).toEqual({
      passed: true,
    });
  }, 60_000);

test("packed ct-config exposes inert Mail descriptors and composes its exact Agents binding", async () => {
  const host = await system();
  try {
    const workspace = await host.workspace("ct-mail", []);
    await host.botlake(["lake", "start", "--workspace", workspace]);
    expect(await host.bl(workspace, "mail", { command: "inbox" }, false)).toContain("Unknown op");
    await host.botlake(["lake", "stop", "--workspace", workspace]);
    await Bun.write(
      join(workspace, ".botlake/lake.ts"),
      `import {createLake} from "@botlake/core";
import identity from "@botlake/extension-identity";
import {agents, flags, references, mail, mailIdentity, mailAgents} from "@botlake/extension-ct-config";
export const lake=createLake({name:"ct-mail", extensions:[identity, agents, flags, references, mail, mailIdentity, mailAgents]});`,
    );
    await host.botlake(["lake", "start", "--workspace", workspace]);
    const message = z.object({ id: z.string(), from: z.string(), status: z.literal("sent") }).parse(
      await host.bl(workspace, "mail", {
        command: "send",
        to: "fixture",
        subject: "Preset mail",
        body: "The configured Mail descriptors share their declared prerequisites.",
      }),
    );
    expect(message.from).toBe("fixture");
    expect(await host.bl(workspace, "mail", { command: "inbox" })).toMatchObject({
      messages: [{ id: message.id }],
      nextOffset: null,
    });
    expect(
      await host.bl(workspace, "mail-agent", { command: "arm", run: message.id }, false),
    ).toContain("verified native identity");
    await host.bl(workspace, "mail", { command: "ack", id: message.id });
    await host.botlake(["lake", "restart", "--workspace", workspace]);
    expect(await host.bl(workspace, "mail", { command: "read", id: message.id })).toMatchObject({
      status: "acknowledged",
      body: "The configured Mail descriptors share their declared prerequisites.",
    });
  } finally {
    await host.close();
  }
}, 60_000);
