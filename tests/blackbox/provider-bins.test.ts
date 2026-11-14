import { expect, test } from "bun:test";
import { chmod } from "node:fs/promises";
import { dirname, join } from "node:path";

import { agentAttributes } from "@botlake/extension-agents";
import { z } from "zod";

import { system } from "./fixtures/system.ts";

const identifier = z.compile(z.object({ id: z.string() }));
const runSchema = z.compile(z.object({ attributes: z.record(z.string(), z.json()) }));
const launchSchema = z.compile(z.object({ command: z.array(z.string()) }));
const catalogSchema = z.compile(z.object({ providers: z.array(z.string()) }));

test("packed ct-config resolves co, cl and piw through PATH and preserves provider gates", async () => {
  const host = await system();
  try {
    const workspace = await host.workspace("packed parent's/ct-bins", [
      "@botlake/extension-batteries",
      "@botlake/extension-identity",
      "./flags.ts",
      "./references.ts",
      "./agents.ts",
      "./mail.ts",
      "./mail-identity.ts",
      "./mail-agents.ts",
    ]);
    const lakeModule = join(workspace, ".botlake/lake.ts");
    await Bun.write(
      lakeModule,
      (await Bun.file(lakeModule).text()).replace(
        `name:${JSON.stringify("packed parent's/ct-bins")}`,
        `name:${JSON.stringify("ct-bins")}`,
      ),
    );
    for (const name of ["flags", "references", "agents", "mail", "mailIdentity", "mailAgents"]) {
      const file = name.replaceAll(/[A-Z]/gu, (character) => `-${character.toLowerCase()}`);
      await Bun.write(
        join(workspace, `${file}.ts`),
        `export { ${name} as default } from "@botlake/extension-ct-config";`,
      );
    }
    for (const [bin, provider] of [
      ["co", "codex"],
      ["cl", "claude"],
      ["piw", "pi"],
    ] as const) {
      const executable = join(dirname(host.blBin), bin);
      await Bun.write(
        executable,
        `#!/usr/bin/env bun
const provider = ${JSON.stringify(provider)};
const args = Bun.argv.slice(2);
const prompt = (await Bun.stdin.text()).trim();
const session = "fixture-" + provider;
if (!args.includes(provider === "codex" ? "--json" : "--print")) throw new Error("Missing native protocol args");
if (provider === "codex") {
  if (!args.includes("--dangerously-bypass-hook-trust")) throw new Error("Missing hook trust flag");
  const configs = args.flatMap((arg, index) => arg === "--config" ? [args[index + 1]] : []);
  if (!configs.includes("features.hooks=true")) throw new Error("Missing hooks feature flag");
  const commands = [];
  for (const event of ["SessionStart", "PostToolUse"]) {
    const config = configs.find((value) => value?.startsWith("hooks." + event + "="));
    if (config === undefined) throw new Error("Missing " + event + " hook");
    const encoded = config.match(/command = ("(?:\\\\.|[^"])*")/u)?.[1];
    if (encoded === undefined) throw new Error("Invalid " + event + " hook command");
    commands.push(JSON.parse(encoded));
  }
  async function hook(command, event) {
    const child = Bun.spawn(["sh", "-c", command], {env: process.env, stdin: "pipe", stdout: "pipe", stderr: "pipe"});
    child.stdin.write(JSON.stringify({hook_event_name: event, session_id: session}));
    child.stdin.end();
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code !== 0) throw new Error(stderr);
    return JSON.parse(stdout);
  }
  const startup = await hook(commands[0], "SessionStart");
  if (!startup.hookSpecificOutput?.additionalContext.match(/identity is \\S+/u)) throw new Error("Missing packed startup instruction");
}
if (provider === "pi") {
  if (args[args.indexOf("--model") + 1] !== "openai-codex/gpt-6-luna") throw new Error("Missing configured Luna model");
  const extension = args[args.indexOf("-e") + 1];
  if (extension === undefined || !(await Bun.file(extension).exists())) throw new Error("Missing packed Pi Mail adapter");
  const handlers = {};
  const loaded = await import(extension);
  loaded.default({on(event, handler) { handlers[event] = handler; }});
  const ctx = {sessionManager: {getSessionId: () => session}};
  await handlers.session_start({}, ctx);
  const startup = await handlers.before_agent_start({systemPrompt: "base"}, ctx);
  if (!startup.systemPrompt.match(/identity is \\S+/u)) throw new Error("Missing packed Pi startup instruction");
}
function emit(event: unknown) { console.log(JSON.stringify(event)); }
if (provider === "claude") emit({session_id: session, result: prompt});
else if (provider === "codex") {
  emit({type: "thread.started", thread_id: session});
  emit({type: "item.completed", item: {type: "agent_message", text: prompt}});
} else {
  emit({type: "session", id: session});
  emit({type: "message_end", message: {role: "assistant", content: [{type: "text", text: prompt}], stopReason: "stop"}});
}
`,
      );
      await chmod(executable, 0o755);
    }
    await host.botlake(["lake", "start", "--workspace", workspace]);
    for (const provider of ["codex", "pi"] as const) {
      const nativeSessionId = `packed-${provider}`;
      const { identity } = z.object({ identity: z.string() }).parse(
        await host.bl(workspace, "agent", {
          command: "native",
          provider,
          nativeSessionId,
          cwd: workspace,
          event: "agent-start",
        }),
      );
      const message = identifier.parse(
        await host.cli([
          "--workspace",
          workspace,
          "--identity",
          identity,
          "--input",
          JSON.stringify({
            command: "send",
            to: identity,
            subject: "Packed adapter",
            body: "Notify and acknowledge",
          }),
          "mail",
        ]),
      );
      if (provider === "codex") {
        const hook = join(workspace, "node_modules/@botlake/extension-ct-config/src/mail/hook.ts");
        const child = Bun.spawn(["bun", hook], {
          env: { ...host.env, BL_WORKSPACE: workspace },
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        });
        await child.stdin.write(
          JSON.stringify({ hook_event_name: "PostToolUse", session_id: nativeSessionId }),
        );
        await child.stdin.end();
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect(code, stderr).toBe(0);
        const output: unknown = JSON.parse(stdout);
        const notice = z
          .object({ hookSpecificOutput: z.object({ additionalContext: z.string() }) })
          .parse(output);
        expect(notice.hookSpecificOutput.additionalContext).toContain("Packed adapter");
      } else {
        const runner = join(workspace, "packed-pi-runner.ts");
        const extension = join(
          workspace,
          "node_modules/@botlake/extension-ct-config/src/mail/pi.ts",
        );
        await Bun.write(
          runner,
          `import adapter from ${JSON.stringify(extension)};
const handlers: Record<string, Function> = {};
adapter({on(event: string, handler: Function) { handlers[event] = handler; }} as never);
const ctx = {sessionManager: {getSessionId: () => ${JSON.stringify(nativeSessionId)}}};
await handlers.session_start?.({}, ctx);
const result = await handlers.tool_result?.({content: []}, ctx);
console.log(JSON.stringify(result));`,
        );
        const child = Bun.spawn(["bun", runner], {
          env: { ...host.env, BL_WORKSPACE: workspace },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect(code, stderr).toBe(0);
        const output: unknown = JSON.parse(stdout);
        const notice = z
          .object({ content: z.array(z.object({ text: z.string().optional() })) })
          .parse(output);
        expect(notice.content.some((part) => part.text?.includes("Packed adapter") === true)).toBe(
          true,
        );
      }
      expect(await host.bl(workspace, "mail", { command: "read", id: message.id })).toMatchObject({
        status: "delivered",
      });
      await host.cli([
        "--workspace",
        workspace,
        "--identity",
        identity,
        "--input",
        JSON.stringify({ command: "ack", id: message.id }),
        "mail",
      ]);
      expect(await host.bl(workspace, "mail", { command: "read", id: message.id })).toMatchObject({
        status: "acknowledged",
      });
    }
    expect(
      catalogSchema.parse(await host.bl(workspace, "agent", { command: "catalog" })).providers,
    ).toEqual(["codex", "pi"]);
    await host.bl(workspace, "flag", { command: "set", name: "agent/claude", value: true });
    expect(
      catalogSchema.parse(await host.bl(workspace, "agent", { command: "catalog" })).providers,
    ).toEqual(["codex", "pi", "claude"]);
    for (const [bin, provider, seat] of [
      ["co", "codex", "codex"],
      ["cl", "claude", "claude"],
      ["piw", "pi", "luna"],
    ] as const) {
      const { id } = identifier.parse(
        await host.bl(workspace, "agent", {
          command: "start",
          seat,
          cwd: workspace,
          prompt: `configured-${bin}`,
        }),
      );
      expect(
        await host.bl(workspace, "await", {
          query: "agent-run-settled",
          params: { runId: id },
          minCount: 1,
          timeoutSecs: 10,
        }),
      ).toMatchObject({ reason: "satisfied" });
      const run = runSchema.parse(await host.bl(workspace, "agent", { command: "show", id }));
      expect(run.attributes[agentAttributes.substatus]).toBe("completed");
      expect(run.attributes[agentAttributes.provider]).toBe(provider);
      expect(run.attributes[agentAttributes.result]).toBe(`configured-${bin}`);
      expect(run.attributes[agentAttributes.integration]).toBe("output");
      const launch = launchSchema.parse(run.attributes[agentAttributes.launch]);
      expect(launch.command).toContain(bin);
      expect(launch.command).not.toContain(join(dirname(host.blBin), bin));
    }
    await host.bl(workspace, "flag", { command: "set", name: "agent/pi", value: false });
    expect(await host.bl(workspace, "agent", { command: "catalog", name: "luna" })).toMatchObject({
      available: false,
    });
  } finally {
    await host.close();
  }
}, 60000);
