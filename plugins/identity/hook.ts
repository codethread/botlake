import { z } from "zod";

import { nativeProject, registerNative, strand } from "./client.ts";

const provider = z.enum(["codex", "claude"]).parse(Bun.argv[2]);
try {
  const event = z
    .object({
      hook_event_name: z.enum(["SessionStart", "SubagentStart"]),
      session_id: z.string().min(1),
      cwd: z.string().min(1),
      agent_id: z.string().optional(),
      model: z.string().optional(),
    })
    .parse(await Bun.stdin.json());
  let nativeSessionId = event.session_id;
  let parentIdentity: string | undefined;
  let childWorkspace: string | undefined;
  if (event.hook_event_name === "SubagentStart") {
    if (provider !== "codex") throw new Error("Child hooks are supported by Codex");
    const workspace =
      process.env["MILLSTRAND_RUN_REFERENCE"] === undefined
        ? await nativeProject(event.cwd)
        : z.string().min(1).parse(process.env["MILLSTRAND_WORKSPACE"]);
    if (workspace === null) process.exit(0);
    const parent = z.object({ identity: z.string() }).parse(
      await strand(workspace, "identity", {
        command: "startup",
        harness: provider,
        nativeSessionId,
      }),
    );
    parentIdentity = parent.identity;
    childWorkspace = workspace;
    nativeSessionId = `codex-child:v1:${Buffer.from(event.session_id).toString("base64url")}:${Buffer.from(z.string().min(1).parse(event.agent_id)).toString("base64url")}`;
  }
  const result = await registerNative({
    provider,
    nativeSessionId,
    cwd: event.cwd,
    ...(parentIdentity === undefined ? {} : { parentIdentity, unmanaged: true }),
    ...(childWorkspace === undefined ? {} : { workspace: childWorkspace }),
    ...(event.model === undefined ? {} : { model: event.model }),
  });
  if (result !== null)
    process.stdout.write(
      `${JSON.stringify({ hookSpecificOutput: { hookEventName: event.hook_event_name, additionalContext: result.instruction } })}\n`,
    );
} catch (error) {
  const message = `Millstrand identity startup failed: ${String(error)}`;
  process.stdout.write(
    `${JSON.stringify(provider === "claude" ? { systemMessage: `${message}; this session is unbound.` } : { continue: false, stopReason: message, systemMessage: message })}\n`,
  );
}
