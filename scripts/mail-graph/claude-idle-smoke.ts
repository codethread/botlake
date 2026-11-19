// Opt-in authenticated probe: new mail wakes an idle interactive Claude Code session.
// Builds the plugins, then runs Claude's TUI in a detached tmux session against a disposable
// Git-backed lake with a session-only --plugin-dir of the built botlake-mail. Mail is sent while
// the prompt is idle; the probe passes once the hooks module records delivery and the transcript
// shows the woken turn. Needs tmux. BL_SMOKE_CLAUDE_BIN selects the launcher (default `claude`).
// Usage: bun scripts/mail-graph/claude-idle-smoke.ts [evidence.json]
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";

import { sessionIdentity } from "@botlake/native-session";
import { z } from "zod";

import { source, system } from "../../tests/blackbox/fixtures/system.ts";

const output = resolve(Bun.argv[2] ?? `/tmp/botlake-claude-idle-smoke-${Date.now()}.json`);
const tmux = `bl-claude-idle-${Date.now()}`;
const host = await system();
try {
  const plugins = join(host.dir, "plugins");
  await run(["bun", join(source, "scripts/plugins.ts"), plugins]);
  const workspace = await host.workspace("claude-idle-mail", ["@botlake/extension-mail"]);
  await run(["git", "init", "-q", workspace]);
  await host.botlake(["lake", "start", "--workspace", workspace]);
  const sessionId = randomUUID();
  const identity = sessionIdentity({ provider: "claude", nativeSessionId: sessionId });
  const trace = join(host.dir, "mail-trace.jsonl");
  const env = Object.entries({ ...host.env, BL_MAIL_TRACE: trace })
    .filter(([key, value]) => value !== undefined && key.startsWith("BL_"))
    .map(([key, value]) => `${key}=${value}`);
  await run([
    "tmux",
    "new-session",
    "-d",
    "-s",
    tmux,
    "-x",
    "200",
    "-y",
    "50",
    "-c",
    workspace,
    "env",
    ...[
      "BL_ACTOR",
      "BL_WORKSPACE",
      "BL_NATIVE_SESSION_ID",
      "BL_NATIVE_PROVIDER",
      "BL_RUN_REFERENCE",
    ].flatMap((name) => ["-u", name]),
    ...env,
    `PATH=${host.env["PATH"]}`,
    process.env["BL_SMOKE_CLAUDE_BIN"] ?? "claude",
    "--session-id",
    sessionId,
    "--model",
    "haiku",
    "--plugin-dir",
    join(plugins, "botlake-mail"),
    "--setting-sources",
    "",
    "--allowedTools",
    "Bash",
  ]);
  // Accept the folder trust dialog (its default is "No, exit"), then let the prompt settle.
  await until(async () => {
    const pane = await capture();
    const trusting = pane.includes("trust this folder");
    if (trusting) await run(["tmux", "send-keys", "-t", tmux, "Down", "Enter"]);
    return !trusting && pane.includes("Claude Code v");
  }, 60_000);
  await Bun.sleep(3000);

  const sent = z.object({ id: z.string() }).parse(
    JSON.parse(
      await run(
        [
          host.env["BL_BIN"] ?? "bl",
          "--workspace",
          workspace,
          "--identity",
          "sender",
          "--input",
          JSON.stringify({
            command: "send",
            to: identity,
            subject: "Idle wake check",
            body: "Reply token: GREY-OWL-17",
          }),
          "mail",
        ],
        host.env,
      ),
    ),
  );
  const status = async () =>
    z
      .object({ status: z.string() })
      .loose()
      .parse(await host.bl(workspace, "mail", { command: "read", id: sent.id })).status;
  await until(async () => (await status()) !== "sent", 60_000);
  await until(async () => (await capture()).includes("Idle wake check"), 30_000);
  // Let the woken turn run so a tool call would expose a duplicate announcement.
  await Bun.sleep(20_000);
  const pane = await capture();
  const observations = (await Bun.file(trace).exists())
    ? (await Bun.file(trace).text())
        .trim()
        .split("\n")
        .map((line) =>
          z
            .object({ event: z.string(), notice: z.string().optional() })
            .loose()
            .parse(JSON.parse(line)),
        )
    : [];
  const announced = observations.filter(
    (observation) =>
      observation.event === "tool-result" &&
      observation.notice?.includes("Idle wake check") === true,
  );
  const finalStatus = await status();
  const evidence = { sessionId, identity, messageId: sent.id, finalStatus, observations, pane };
  await Bun.write(output, `${JSON.stringify(evidence, null, 2)}\n`);
  const passed = finalStatus !== "sent" && announced.length === 0;
  console.log(JSON.stringify({ passed, finalStatus, duplicates: announced.length, output }));
  if (!passed) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${await capture().catch(() => "")}\n`);
  throw error;
} finally {
  await Bun.spawn(["tmux", "kill-session", "-t", tmux]).exited;
  await host.close();
}

async function capture(): Promise<string> {
  return run(["tmux", "capture-pane", "-p", "-S", "-200", "-t", tmux]);
}

async function run(command: string[], env = process.env): Promise<string> {
  const child = Bun.spawn(command, { env, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`${command.join(" ")} exited ${code}: ${stderr}`);
  return stdout;
}

async function until(check: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs}ms`);
    await Bun.sleep(1000);
  }
}
