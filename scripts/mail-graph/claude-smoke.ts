// Opt-in authenticated native Claude Code probe for plugins/mail.
// Uses a private supervisor, disposable lake and session-only --plugin-dir; never installs
// plugins or edits profiles. BL_SMOKE_CLAUDE_BIN selects the launcher (default `claude`).
// Usage: bun scripts/mail-graph/claude-smoke.ts [evidence.json]
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";

import { sessionIdentity } from "@botlake/native-session";
import { z } from "zod";

import { source, system } from "../../tests/blackbox/fixtures/system.ts";

const output = resolve(Bun.argv[2] ?? `/tmp/botlake-claude-mail-smoke-${Date.now()}.json`);
const host = await system();
try {
  const workspace = await host.workspace("claude-mail", ["@botlake/extension-mail"]);
  await host.botlake(["lake", "start", "--workspace", workspace]);
  const sessionId = randomUUID();
  const identity = sessionIdentity({ provider: "claude", nativeSessionId: sessionId });
  const trace = join(host.dir, "mail-trace.jsonl");
  const sent = z.object({ id: z.string() }).parse(
    await host.bl(workspace, "mail", {
      command: "send",
      to: identity,
      subject: "Smoke check",
      body: "Reply token: BLUE-HERON-42",
    }),
  );
  const prompt = [
    "Run the Bash command `true` exactly once.",
    "Then follow any Botlake mail notification: read the pending message with the inbox/read command from your context and acknowledge it.",
    "Finally reply with your Botlake mail identity, the subject you were notified about, and the message body's reply token.",
  ].join(" ");
  const child = Bun.spawn(
    [
      process.env["BL_SMOKE_CLAUDE_BIN"] ?? "claude",
      "-p",
      prompt,
      "--session-id",
      sessionId,
      "--plugin-dir",
      join(source, "plugins/mail"),
      "--setting-sources",
      "",
      "--allowedTools",
      "Bash",
      "--output-format",
      "json",
    ],
    {
      cwd: workspace,
      env: { ...host.env, BL_WORKSPACE: workspace, BL_MAIL_TRACE: trace },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const message = z
    .object({ status: z.string() })
    .loose()
    .parse(await host.bl(workspace, "mail", { command: "read", id: sent.id }));
  const observations = (await Bun.file(trace).text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as unknown);
  const reply = z.object({ result: z.string() }).loose().parse(JSON.parse(stdout)).result;
  const evidence = {
    code,
    sessionId,
    identity,
    messageId: sent.id,
    message,
    observations,
    reply,
    stderr,
  };
  await Bun.write(output, `${JSON.stringify(evidence, null, 2)}\n`);
  const passed =
    code === 0 &&
    message.status === "acknowledged" &&
    reply.includes(identity) &&
    reply.includes("BLUE-HERON-42") &&
    JSON.stringify(observations).includes("Smoke check");
  console.log(JSON.stringify({ passed, output }));
  if (!passed) process.exitCode = 1;
} finally {
  await host.close();
}
