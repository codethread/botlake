// Opt-in authenticated probe: Mail wakes Claude only within the window after a completed turn.
// Uses a disposable Git-backed lake, a short window, and a session-only --plugin-dir in tmux.
// BL_SMOKE_CLAUDE_BIN selects the launcher (default `claude`).
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
  await Bun.write(
    join(workspace, ".botlake/lake.ts"),
    `import { createLake } from "@botlake/core";
import { mail } from "@botlake/extension-mail";
export const lake = createLake({ name: "claude-idle-mail", extensions: [mail({ idleWake: { defaultSecs: 6 } })] });
`,
  );
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
  const observationSchema = z
    .object({
      event: z.string(),
      notice: z.string().optional(),
      ids: z.array(z.string()).optional(),
      expiresAt: z.number().optional(),
    })
    .loose();
  async function observations() {
    const file = Bun.file(trace);
    if (!(await file.exists())) return [];
    return (await file.text())
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => observationSchema.parse(JSON.parse(line)));
  }
  async function send(subject: string) {
    const request = { command: "send", to: identity, subject, body: "Body stays behind the CLI" };
    const result = await host.cli([
      "--workspace",
      workspace,
      "--identity",
      "sender",
      "--input",
      JSON.stringify(request),
      "mail",
    ]);
    return z.object({ id: z.string() }).parse(result).id;
  }
  async function status(id: string) {
    return z
      .object({ status: z.string() })
      .parse(await host.bl(workspace, "mail", { command: "read", id })).status;
  }
  async function prompt(text: string) {
    await run(["tmux", "send-keys", "-t", tmux, "-l", text]);
    await run(["tmux", "send-keys", "-t", tmux, "Enter"]);
  }

  await until(
    async () => (await observations()).some((item) => item.event === "session-start"),
    30_000,
  );
  const before = await send("Before the first turn");
  await Bun.sleep(6_000);
  const beforeTurn = await status(before);
  if (beforeTurn !== "sent" || (await capture()).includes("Before the first turn"))
    throw new Error("Mail woke Claude before a completed model turn");
  await host.cli([
    "--workspace",
    workspace,
    "--identity",
    identity,
    "--input",
    JSON.stringify({ command: "ack", id: before }),
    "mail",
  ]);

  await prompt("Reply exactly READY-17 without calling any tools.");
  // This empty wait ends at the configured deadline, not the normal two-minute wait budget.
  await until(
    async () =>
      (await observations()).some((item) => item.event === "idle-wait" && item.ids?.length === 0),
    60_000,
  );
  const subject = "Mail sent after idle expiry";
  const id = await send(subject);
  await Bun.sleep(6_000);
  const afterExpiry = await status(id);
  if (afterExpiry !== "sent" || (await capture()).includes(subject))
    throw new Error("Mail woke Claude after the idle deadline");

  await prompt("Reply exactly READY-18 without calling any tools.");
  await until(async () => (await status(id)) === "delivered", 60_000);
  await until(async () => (await capture()).includes(subject), 30_000);
  const observed = await observations();
  const duplicate = observed.some(
    (item) => item.event === "tool-result" && item.notice?.includes(subject) === true,
  );
  const nudges = observed.filter(
    (item) => item.event === "idle-nudge" && item.ids?.includes(id) === true,
  );
  const pane = await capture();
  const passed = !duplicate && nudges.length === 1;
  const evidence = {
    passed,
    sessionId,
    identity,
    beforeTurn,
    afterExpiry,
    id,
    finalStatus: await status(id),
    observations: observed,
    pane,
  };
  await Bun.write(output, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(
    JSON.stringify({ passed, beforeTurn, afterExpiry, finalStatus: evidence.finalStatus, output }),
  );
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
