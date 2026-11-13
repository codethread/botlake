import { expect, test } from "bun:test";
import { join } from "node:path";

import { sessionIdentity } from "@botlake/native-session";
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

test("Mail hook delivers provider-scoped Claude and Codex notifications through native hook I/O", async () => {
  const host = await system();
  try {
    const workspace = await host.workspace("hook-mail", ["@botlake/extension-mail"]);
    await host.botlake(["lake", "start", "--workspace", workspace]);
    const env = { ...host.env, BL_WORKSPACE: workspace };
    const hook = async (provider: string, input: Record<string, unknown>, hookEnv = env) => {
      const child = Bun.spawn(["bun", join(source, "plugins/mail/hook.ts"), provider], {
        env: hookEnv,
        stdin: new Blob([JSON.stringify({ session_id: "shared", cwd: workspace, ...input })]),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
      expect(code).toBe(0);
      return z.record(z.string(), z.unknown()).parse(JSON.parse(stdout));
    };
    const contextSchema = z.object({
      hookSpecificOutput: z.object({ hookEventName: z.string(), additionalContext: z.string() }),
    });
    const claude = sessionIdentity({ provider: "claude", nativeSessionId: "shared" });
    const codex = sessionIdentity({ provider: "codex", nativeSessionId: "shared" });
    expect(claude).not.toBe(codex);

    const start = contextSchema.parse(await hook("claude", { hook_event_name: "SessionStart" }));
    expect(start.hookSpecificOutput.additionalContext).toContain(
      `Your Botlake mail identity is ${claude}.`,
    );
    expect(start.hookSpecificOutput.additionalContext).toContain("prime mail");

    const send = async (to: string, subject: string) =>
      z
        .object({ id: z.string() })
        .parse(
          await host.bl(workspace, "mail", { command: "send", to, subject, body: "secret body" }),
        ).id;
    const id = await send(claude, "Claude review");
    await send(codex, "Codex only");
    const tool = { tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "true" } };
    expect(
      await hook("claude", { hook_event_name: "PostToolUse", agent_id: "child", ...tool }),
    ).toEqual({});

    const notice = contextSchema.parse(
      await hook("claude", { hook_event_name: "PostToolUse", ...tool }),
    );
    expect(notice.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(notice.hookSpecificOutput.additionalContext).toContain("1 pending mail message:");
    expect(notice.hookSpecificOutput.additionalContext).toContain("Claude review");
    expect(notice.hookSpecificOutput.additionalContext).not.toContain("Codex only");
    expect(notice.hookSpecificOutput.additionalContext).not.toContain("secret body");
    expect(await hook("claude", { hook_event_name: "PostToolUse", ...tool })).toEqual({});

    await send(claude, "After failure");
    const failure = contextSchema.parse(
      await hook("claude", { hook_event_name: "PostToolUseFailure", ...tool }),
    );
    expect(failure.hookSpecificOutput.hookEventName).toBe("PostToolUseFailure");
    expect(failure.hookSpecificOutput.additionalContext).toContain("After failure");

    const codexNotice = contextSchema.parse(
      await hook("codex", { hook_event_name: "PostToolUse", ...tool }),
    );
    expect(codexNotice.hookSpecificOutput.additionalContext).toContain("Codex only");

    const read = await host.cli([
      "--workspace",
      workspace,
      "--identity",
      claude,
      "--input",
      JSON.stringify({ command: "read", id }),
      "mail",
    ]);
    expect(read).toMatchObject({ status: "delivered", body: "secret body" });
    await host.cli([
      "--workspace",
      workspace,
      "--identity",
      claude,
      "--input",
      JSON.stringify({ command: "ack", id }),
      "mail",
    ]);

    const unavailable = await hook(
      "claude",
      { hook_event_name: "PostToolUse", ...tool },
      { ...env, BL_WORKSPACE: join(host.dir, "missing-lake") },
    );
    expect(z.object({ systemMessage: z.string() }).parse(unavailable).systemMessage).toContain(
      "Botlake mail hook failed",
    );
  } finally {
    await host.close();
  }
}, 120_000);
