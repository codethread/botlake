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
    const lakeModule = join(workspace, ".botlake/lake.ts");
    await Bun.write(
      lakeModule,
      `import {createLake} from "@botlake/core";
import identity from "@botlake/extension-identity";
import {agents, flags, references} from "@botlake/extension-ct-config";
export const lake=createLake({name:"ct-mail", extensions:[identity, agents, flags, references]});`,
    );
    expect(await host.botlake(["lake", "start", "--workspace", workspace], false)).toContain(
      "agents requires explicitly selected mail",
    );
    await Bun.write(
      lakeModule,
      `import {createLake} from "@botlake/core";
import identity from "@botlake/extension-identity";
import batteries from "@botlake/extension-batteries";
import {agents, flags, references, mail, mailIdentity, mailAgents} from "@botlake/extension-ct-config";
export const lake=createLake({name:"ct-mail", extensions:[identity, batteries, agents, flags, references, mail, mailIdentity, mailAgents]});`,
    );
    await host.botlake(["lake", "start", "--workspace", workspace]);
    const observed = z.object({ identity: z.string() }).parse(
      await host.bl(workspace, "agent", {
        command: "native",
        provider: "pi",
        nativeSessionId: "preset-mail",
        cwd: workspace,
        event: "agent-start",
      }),
    );
    const mail = (input: unknown) =>
      host.cli([
        "--workspace",
        workspace,
        "--identity",
        observed.identity,
        "--input",
        JSON.stringify(input),
        "mail",
      ]);
    const message = z.object({ id: z.string(), from: z.string(), status: z.literal("sent") }).parse(
      await mail({
        command: "send",
        to: observed.identity,
        subject: "Preset mail",
        body: "The configured Mail descriptors share their declared prerequisites.",
      }),
    );
    expect(message.from).toBe(observed.identity);
    expect(await mail({ command: "inbox" })).toMatchObject({
      messages: [{ id: message.id }],
      nextOffset: null,
    });
    const inactive = z
      .object({
        id: z.string(),
        status: z.literal("undeliverable"),
        reason: z.literal("recipient_inactive"),
      })
      .parse(
        await mail({
          command: "send",
          to: "inactive-agent",
          subject: "Inactive",
          body: "No automatic retry",
        }),
      );
    expect(
      await host.bl(workspace, "await", {
        query: "mail-undeliverable",
        params: { id: inactive.id },
        minCount: 1,
        timeoutSecs: 0,
      }),
    ).toMatchObject({ reason: "satisfied" });
    await mail({ command: "ack", id: message.id });
    await host.botlake(["lake", "restart", "--workspace", workspace]);
    expect(await host.bl(workspace, "mail", { command: "read", id: message.id })).toMatchObject({
      status: "acknowledged",
      body: "The configured Mail descriptors share their declared prerequisites.",
    });
  } finally {
    await host.close();
  }
}, 60_000);
