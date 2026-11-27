import { expect, test } from "bun:test";
import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { sessionIdentity } from "@botlake/native-session";
import { z } from "zod";

import { source, system } from "./fixtures/system.ts";

const sent = z.compile(z.object({ id: z.string() }));
const hookOutput = z.compile(
  z.object({
    hookSpecificOutput: z
      .object({ hookEventName: z.string(), additionalContext: z.string() })
      .optional(),
    systemMessage: z.string().optional(),
  }),
);

async function run(command: string[], env: Record<string, string | undefined>, stdin = "") {
  const child = Bun.spawn(command, { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  await child.stdin.write(stdin);
  await child.stdin.end();
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(code, stderr).toBe(0);
  return stdout;
}

test("built mail plugin notifies Claude, Codex and Pi root sessions", async () => {
  const host = await system();
  try {
    // Exercise the self-contained build users install, away from workspace node_modules.
    const marketplace = join(host.dir, "plugins");
    await run(["bun", join(source, "scripts/plugins.ts"), marketplace], host.env);
    const hook = join(marketplace, "botlake-mail/hook.ts");
    const piAdapter = join(marketplace, "botlake-mail/pi.ts");
    const lake = await host.workspace("mail-plugin", [
      "@botlake/extension-batteries",
      "@botlake/extension-identity",
      "@botlake/extension-mail",
    ]);
    const plain = await host.workspace("no-mail", ["@botlake/extension-batteries"]);
    const outside = join(host.dir, "outside");
    await mkdir(outside);
    for (const workspace of [lake, plain]) {
      await run(["git", "init", "-q", workspace], host.env);
      await host.botlake(["lake", "start", "--workspace", workspace]);
    }
    // Direct sessions discover the lake from their working directory, as a global install would.
    const direct = { ...host.env, BL_WORKSPACE: undefined };
    const subdir = join(lake, "src");
    await mkdir(subdir);

    async function send(to: string, subject: string): Promise<string> {
      const input = JSON.stringify({
        command: "send",
        to,
        subject,
        body: "Body stays behind the CLI",
      });
      return sent.parse(
        await host.cli(["--workspace", lake, "--identity", "sender", "--input", input, "mail"]),
      ).id;
    }
    async function status(id: string): Promise<unknown> {
      return z
        .object({ status: z.string() })
        .parse(await host.bl(lake, "mail", { command: "read", id })).status;
    }
    async function fire(
      provider: "claude" | "codex",
      event: Record<string, unknown>,
      env: Record<string, string | undefined> = direct,
    ) {
      return hookOutput.parse(
        JSON.parse(await run(["bun", hook, provider], env, JSON.stringify(event))),
      );
    }

    for (const provider of ["claude", "codex"] as const) {
      const session = `${provider}-root`;
      const identity = sessionIdentity({ provider, nativeSessionId: session });
      const waiting = await send(identity, `Before ${provider} start`);
      const startup = await fire(provider, {
        hook_event_name: "SessionStart",
        session_id: session,
        cwd: subdir,
      });
      expect(startup.hookSpecificOutput?.hookEventName).toBe("SessionStart");
      expect(startup.hookSpecificOutput?.additionalContext).toContain(
        `Your Botlake mail identity is ${identity}`,
      );
      expect(startup.hookSpecificOutput?.additionalContext).toContain(`Before ${provider} start`);
      expect(startup.hookSpecificOutput?.additionalContext).not.toContain("BL_WORKSPACE");
      expect(startup.hookSpecificOutput?.additionalContext).not.toContain("Body stays");
      expect(await status(waiting)).toBe("delivered");

      const idle = { hook_event_name: "PostToolUse", session_id: session, cwd: subdir };
      expect(await fire(provider, idle)).toEqual({});
      const arrived = await send(identity, `During ${provider} tools`);
      // Native subagents share the root session ID but never consume its mail.
      expect(await fire(provider, { ...idle, agent_id: "child" })).toEqual({});
      expect(await status(arrived)).toBe("sent");
      const notice = await fire(provider, idle);
      expect(notice.hookSpecificOutput?.hookEventName).toBe("PostToolUse");
      expect(notice.hookSpecificOutput?.additionalContext).toContain(`During ${provider} tools`);
      expect(await status(arrived)).toBe("delivered");
    }

    // Managed runs inherit BL_WORKSPACE and may work outside the lake.
    const managed = await fire(
      "claude",
      { hook_event_name: "SessionStart", session_id: "managed", cwd: outside },
      { ...host.env, BL_WORKSPACE: lake },
    );
    expect(managed.hookSpecificOutput?.additionalContext).toContain('--workspace "$BL_WORKSPACE"');

    // Outside a lake, or in a lake without Mail, the plugin stays silent.
    for (const cwd of [outside, plain])
      for (const hook_event_name of ["SessionStart", "PostToolUse"])
        expect(await fire("claude", { hook_event_name, session_id: "quiet", cwd })).toEqual({});

    // Claude's idle hooks module ships as source beside the bundled hook it drives. Its checks
    // leave mail eligible until the woken turn's handoff is recorded.
    expect(
      await Bun.file(join(marketplace, "botlake-mail/.claude-plugin/hooks.json")).json(),
    ).toMatchObject({ modules: ["../claude.ts"] });
    expect(await Bun.file(join(marketplace, "botlake-mail/claude.ts")).exists()).toBe(true);
    const idleIdentity = sessionIdentity({ provider: "claude", nativeSessionId: "claude-idle" });
    const idleReply = z.object({ ids: z.array(z.string()), notice: z.string() });
    async function idleHook(
      event: Record<string, unknown>,
      cwd = subdir,
      env: Record<string, string | undefined> = direct,
    ): Promise<unknown> {
      const input = { session_id: "claude-idle", cwd, ...event };
      return JSON.parse(await run(["bun", hook, "claude"], env, JSON.stringify(input)));
    }
    const turnEndedAt = Date.now();
    const deadline = { hook_event_name: "IdleMailDeadline", turnEndedAt };
    const { expiresAt } = z.object({ expiresAt: z.number() }).parse(await idleHook(deadline));
    expect(expiresAt).toBe(turnEndedAt + 300_000);
    const held = { hook_event_name: "IdleMail", expiresAt };
    // A held wait answers when the mail is sent, not on a polling interval.
    const parked = idleHook(held);
    await Bun.sleep(1500);
    const idleMail = await send(idleIdentity, "While Claude idles");
    const woken = idleReply.parse(await parked);
    expect(woken.ids).toEqual([idleMail]);
    expect(woken.notice).toContain("While Claude idles");
    expect(woken.notice).not.toContain("Body stays");
    expect(await status(idleMail)).toBe("sent");
    expect(idleReply.parse(await idleHook(held)).ids).toEqual([idleMail]);

    const expired = { ...held, expiresAt: turnEndedAt };
    expect(await idleHook(expired)).toEqual({ ids: [], notice: "" });
    expect(await status(idleMail)).toBe("sent");

    const shims = join(host.dir, "shims");
    await mkdir(shims);
    async function shim(name: string, body: string): Promise<Record<string, string | undefined>> {
      const path = join(shims, name);
      await Bun.write(path, `#!/bin/sh\n${body}\nexec ${JSON.stringify(host.blBin)} "$@"\n`);
      await chmod(path, 0o755);
      return { ...direct, BL_BIN: path };
    }

    // A lake too busy to answer is not an outage: tool results stay quiet and the mod retries.
    const stalled = await shim("stalled-bl", "sleep 4");
    expect(await idleHook(deadline, subdir, stalled)).toEqual({ busy: true });
    expect(
      await fire(
        "claude",
        { hook_event_name: "PostToolUse", session_id: "claude-idle", cwd: subdir },
        stalled,
      ),
    ).toEqual({});
    expect(await status(idleMail)).toBe("sent");

    expect(await idleHook({ hook_event_name: "IdleMailDelivered", ids: [idleMail] })).toEqual({});
    expect(await status(idleMail)).toBe("delivered");
    // Without Mail the module stops.
    for (const cwd of [outside, plain])
      expect(await idleHook(deadline, cwd)).toEqual({ inactive: true });

    const piSession = "pi-root";
    const piIdentity = sessionIdentity({ provider: "pi", nativeSessionId: piSession });
    const piMail = await send(piIdentity, "For Pi");
    const runner = join(host.dir, "pi-runner.ts");
    await Bun.write(
      runner,
      `import adapter from ${JSON.stringify(piAdapter)};
const handlers: Record<string, Function> = {};
adapter({on(event: string, handler: Function) { handlers[event] = handler; }} as never);
const results: Record<string, unknown> = {};
for (const cwd of ${JSON.stringify([plain, subdir])}) {
  const ctx = {mode: "rpc", cwd, sessionManager: {getSessionId: () => ${JSON.stringify(piSession)}}};
  await handlers.session_start({}, ctx);
  const sections: Record<string, string> = {botlake: "identity"};
  await handlers.before_agent_start({systemPrompt: "base", systemPromptOptions: {sections}}, ctx);
  results[cwd] = {sections, tool: await handlers.tool_result({content: [{type: "text", text: "ok"}]}, ctx)};
}
console.log(JSON.stringify(results));`,
    );
    const pi = z
      .record(
        z.string(),
        z.object({
          sections: z.record(z.string(), z.string()),
          tool: z.object({ content: z.array(z.object({ text: z.string() })) }).optional(),
        }),
      )
      .parse(JSON.parse(await run(["bun", runner], direct)));
    expect(pi[plain]).toEqual({ sections: { botlake: "identity" } });
    expect(pi[subdir]?.sections["botlake"]).toBe("identity");
    expect(pi[subdir]?.sections["botlake-mail"]).toContain(piIdentity);
    expect(pi[subdir]?.tool?.content[0]?.text).toBe("ok");
    expect(pi[subdir]?.tool?.content[1]?.text).toContain("For Pi");
    expect(await status(piMail)).toBe("delivered");

    // The TUI receives one native turn trigger without any tool call. A tool result fired
    // by that turn must wait for the idle handoff receipt, not announce the same batch.
    const waiting = await send(piIdentity, "Wake the terminal");
    const repoll = join(shims, "repoll");
    const release = join(shims, "release");
    const pauseRepoll = await shim(
      "pause-repoll",
      `case "$*" in
        *'"command":"wait"'*) touch "${repoll}.armed";;
        *'"command":"list"'*)
          if [ -e "${repoll}.armed" ] && [ ! -e "${release}" ]; then
            touch "${repoll}"
            while [ ! -e "${release}" ]; do sleep 0.02; done
          fi;;
      esac`,
    );
    await Bun.write(
      runner,
      `import adapter from ${JSON.stringify(piAdapter)};
const handlers = {};
const ctx = {mode: "tui", cwd: ${JSON.stringify(subdir)}, isIdle: () => true,
  sessionManager: {getSessionId: () => ${JSON.stringify(piSession)}}};
const received = Promise.withResolvers();
let wakes = 0;
let offset = 0;
const now = Date.now;
Date.now = () => now() + offset;
const repoll = ${JSON.stringify(repoll)};
const repollArmed = Bun.file(${JSON.stringify(`${repoll}.armed`)});
const release = ${JSON.stringify(release)};
const complete = {messages: [{role: "assistant", stopReason: "stop"}]};
adapter({on(event, handler) { handlers[event] = handler; }, sendMessage(message, options) {
  wakes++;
  handlers.agent_start({}, ctx);
  const tool = handlers.tool_result({content: []}, ctx);
  received.resolve(Promise.resolve(tool).then(result => ({message, options, tool: result})));
}});
try {
  await handlers.session_start({}, ctx);
  // Resuming a session, or ending a run with no model answer, must not open a window.
  handlers.agent_start({}, ctx);
  handlers.agent_end({messages: [{role: "assistant", stopReason: "aborted"}]}, ctx);
  await Bun.sleep(5250);
  if (wakes !== 0 || await repollArmed.exists()) throw new Error("Wait started before a completed turn");
  handlers.agent_start({}, ctx);
  handlers.agent_end(complete, ctx);
  for (let i = 0; !(await Bun.file(repoll).exists()); ++i) {
    if (i === 250) throw new Error("Did not repoll after the held wait");
    await Bun.sleep(20);
  }
  // Expire after the wait answered but while the final poll is still in flight.
  offset = 301000;
  await Bun.write(release, "");
  await Bun.sleep(500);
  if (wakes !== 0) throw new Error("Handed off a poll that crossed the deadline");
  offset = 0;
  handlers.agent_start({}, ctx);
  handlers.agent_end(complete, ctx);
  const timeout = setTimeout(() => received.reject(new Error("No idle mail turn")), 8000);
  try {
    console.log(JSON.stringify(await received.promise));
  } finally {
    clearTimeout(timeout);
  }
} finally {
  handlers.session_shutdown({}, ctx);
  await Bun.write(release, "");
}`,
    );
    const handoff = z
      .object({
        message: z.object({
          customType: z.literal("botlake-mail"),
          content: z.string(),
          display: z.literal(true),
        }),
        options: z.object({ triggerTurn: z.literal(true) }),
        tool: z.object({ content: z.array(z.unknown()).length(0) }),
      })
      .parse(JSON.parse(await run(["bun", runner], pauseRepoll)));
    expect(handoff.message.content).toContain("Wake the terminal");
    expect(handoff.message.content).not.toContain("Body stays");
    expect(await status(waiting)).toBe("delivered");
  } finally {
    await host.close();
  }
}, 60000);
