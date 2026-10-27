// Opt-in authenticated probe. Uses private homes, plugins, supervisor and SQLite; never installs globally.
import { copyFile, cp, mkdir, symlink, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { provider } from "@botlake/extension-agents";
import { z } from "zod";

import { system } from "../tests/blackbox/fixtures/system.ts";

const selection = z.enum(["pi", "codex", "both"]).parse(Bun.argv[2] ?? "both");
const names: Array<"pi" | "codex"> = selection === "both" ? ["pi", "codex"] : [selection];
const output = resolve(Bun.argv[3] ?? `/tmp/botlake-native-smoke-${Date.now()}.json`);
const runSchema = z.object({ id: z.string(), attributes: z.record(z.string(), z.json()) });
const host = await system();
const owned: string[] = [];
const evidence: unknown[] = [];
const marker = "BL_NATIVE_SMOKE";
const prompt = `Do not use tools or edit files. Reply with ${marker} followed by your exact Botlake identity from your system/developer context.`;

try {
  const workspace = await host.workspace("native-smoke", [
    "@botlake/extension-identity",
    "@botlake/extension-flags",
    "./agents.ts",
  ]);

  await exec(["git", "init", "--quiet"], workspace);
  const plugin = join(workspace, "node_modules/@botlake/identity");
  const settings: Record<
    string,
    { model: string; extraArgs: string[]; env: Record<string, string> }
  > = {};
  for (const name of names) {
    const home = join(host.dir, name);
    await mkdir(home, { recursive: true });
    if (name === "pi") {
      const original = process.env["PI_CODING_AGENT_DIR"] ?? join(homedir(), ".pi/agent");
      await credential(join(original, "auth.json"), join(home, "auth.json"));
      await credential(join(original, "models.json"), join(home, "models.json"));
      await Bun.write(join(home, "settings.json"), "{}");
      settings[name] = {
        model: process.env["BL_SMOKE_PI_MODEL"] ?? "openai-codex/gpt-5.6-luna",
        extraArgs: [
          "--no-extensions",
          "--extension",
          join(plugin, "pi.ts"),
          "--no-skills",
          "--no-prompt-templates",
          "--no-context-files",
          "--no-themes",
          "--no-tools",
          "--offline",
          "--session-dir",
          join(home, "sessions"),
        ],
        env: { PI_CODING_AGENT_DIR: home },
      };
    } else {
      const original = process.env["CODEX_HOME"] ?? join(homedir(), ".codex");
      await credential(join(original, "auth.json"), join(home, "auth.json"));
      const cache = join(home, "plugins/cache/botlake/botlake-identity");
      await mkdir(cache, { recursive: true });
      await cp(plugin, join(cache, "local"), { recursive: true, dereference: true });
      await symlink(join(workspace, "node_modules"), join(cache, "local/node_modules"), "dir");
      await Bun.write(
        join(home, "config.toml"),
        '[features]\nplugins = true\nhooks = true\nremote_plugin = false\n\n[plugins."botlake-identity@botlake"]\nenabled = true\n',
      );
      settings[name] = {
        model: process.env["BL_SMOKE_CODEX_MODEL"] ?? "gpt-5.6-luna",
        extraArgs: ["--sandbox", "read-only", "--dangerously-bypass-hook-trust", "--ignore-rules"],
        env: { CODEX_HOME: home, CODEX_APP_SERVER_DISABLE_MANAGED_CONFIG: "1" },
      };
    }
  }

  await Bun.write(
    join(workspace, "agents.ts"),
    `import {agents,provider} from "@botlake/extension-agents";
const settings=${JSON.stringify(settings)};
export default agents({providers:Object.entries(settings).map(([name,setting])=>{const base=provider(name);return {...base,prepare(run){const plan=base.prepare(run);return {...plan,env:{...plan.env,...setting.env}}}}}),aliases:Object.fromEntries(Object.entries(settings).map(([name,setting])=>[name+"-luna",{provider:name,model:setting.model,extraArgs:setting.extraArgs}]))});`,
  );
  await host.botlake(["lake", "start", "--workspace", workspace]);
  async function settled(id: string): Promise<z.infer<typeof runSchema>> {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      await host.bl("native-smoke", "agent", { command: "reconcile" });
      const run = runSchema.parse(await host.bl("native-smoke", "agent", { command: "show", id }));
      if (run.attributes["agent/settled"] === true) return run;
      await Bun.sleep(200);
    }

    throw new Error(`Native run timed out: ${id}`);
  }
  function lifecycle(run: z.infer<typeof runSchema>): void {
    const observed = z
      .object({
        event: z.literal("session-end"),
        activity: z.literal("ended"),
        model: z.string().min(1),
        thinkingLevel: z.string().optional(),
      })
      .parse(run.attributes["agent/observation"]);
    if (run.attributes["agent/provider"] === "pi") z.string().min(1).parse(observed.thinkingLevel);
  }
  function verify(run: z.infer<typeof runSchema>): void {
    check(run.attributes["agent/substatus"] === "completed", JSON.stringify(run));
    lifecycle(run);
    check(
      run.attributes["agent/integration"] === "native",
      `Plugin did not bind: ${JSON.stringify(run)}`,
    );
    const result = z.string().parse(run.attributes["agent/result"]);
    check(result.includes(marker), `Missing probe answer: ${result}`);
    check(
      result.includes(z.string().parse(run.attributes["agent/identity"])),
      `Identity context missing: ${result}`,
    );
  }
  for (const name of names) {
    process.stderr.write(`Testing ${name} Luna: managed start, resume, direct native session\n`);
    const started = runSchema.parse(
      await host.bl("native-smoke", "agent", {
        command: "start",
        seat: `${name}-luna`,
        cwd: workspace,
        prompt,
      }),
    );

    owned.push(started.id);
    const first = await settled(started.id);
    verify(first);
    const resumed = runSchema.parse(
      await host.bl("native-smoke", "agent", { command: "resume", id: first.id, prompt }),
    );
    owned.push(resumed.id);
    const continuation = await settled(resumed.id);
    verify(continuation);
    check(
      first.attributes["agent/session-id"] === continuation.attributes["agent/session-id"],
      "Resume changed native session",
    );
    check(
      first.attributes["agent/identity"] === continuation.attributes["agent/identity"],
      "Resume changed identity",
    );
    const setting = z
      .object({
        model: z.string(),
        extraArgs: z.array(z.string()),
        env: z.record(z.string(), z.string()),
      })
      .parse(settings[name]);

    const definition = {
      provider: name,
      cwd: workspace,
      prompt,
      resumes: false as const,
      model: setting.model,
      extraArgs: setting.extraArgs,
      systemPrompt: "",
    };
    const plan = provider(name).prepare(definition);

    const stdout = await exec(
      plan.command,
      workspace,
      {
        ...host.env,
        ...setting.env,
        BL_WORKSPACE: workspace,
        BL_RUN_REFERENCE: undefined,
        BL_NATIVE_SESSION_ID: undefined,
        BL_NATIVE_PROVIDER: undefined,
        BL_ACTOR: undefined,
        BL_AGENT_SEAT: undefined,
        BL_MODEL: undefined,
        BL_EFFORT: undefined,
      },
      plan.stdin,
    );
    const outcome = provider(name).finish(definition, 0, stdout, "");
    check(outcome.success, JSON.stringify(outcome));
    const runs = z
      .array(runSchema)
      .parse(await host.bl("native-smoke", "agent", { command: "list" }));
    const external = runs.find(
      (run) =>
        run.attributes["agent/session-id"] === outcome.sessionId &&
        run.attributes["agent/external"] === true,
    );
    check(external !== undefined, "Direct native session was not registered");
    lifecycle(external);
    const identity = z.string().parse(external.attributes["agent/identity"]);
    check(
      outcome.result?.includes(identity) === true,
      `Direct native identity context mismatch: expected ${identity}, received ${JSON.stringify(outcome.result)}`,
    );
    check(
      external.attributes["agent/settled"] === undefined,
      "External observation claimed settlement",
    );
    const stop = await host.bl(
      "native-smoke",
      "agent",
      { command: "cancel", id: external.id },
      false,
    );
    check(
      typeof stop === "string" && stop.includes("no stop authority"),
      "External process gained custody",
    );
    evidence.push({
      provider: name,
      model: setting.model,
      version: (await exec([name, "--version"], workspace)).trim(),
      first,
      continuation,
      external,
    });
    process.stderr.write(`${name}: passed\n`);
  }
  await Bun.write(
    output,
    `${JSON.stringify({ at: new Date().toISOString(), evidence }, null, 2)}\n`,
  );
  process.stdout.write(`${JSON.stringify({ result: "passed", output, providers: names })}\n`);
} finally {
  try {
    for (const id of owned) {
      const run = runSchema.parse(await host.bl("native-smoke", "agent", { command: "show", id }));
      if (run.attributes["agent/settled"] !== true)
        await host.bl("native-smoke", "agent", { command: "cancel", id });
    }
  } finally {
    await host.close();
  }
}

// -- Private helpers --

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function credential(source: string, target: string): Promise<void> {
  if (await Bun.file(source).exists()) {
    await copyFile(source, target);
    await chmod(target, 0o600);
  }
}

async function exec(command: string[], cwd: string, env = host.env, stdin = ""): Promise<string> {
  const child = Bun.spawn(command, {
    cwd,
    env,
    stdin: new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
    timeout: 120_000,
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`${command[0]} exited ${code}: ${stderr}`);
  if (
    stderr.includes("Botlake tracking unavailable") ||
    stderr.includes("Botlake native adapter failed")
  )
    throw new Error(stderr);
  return stdout;
}
