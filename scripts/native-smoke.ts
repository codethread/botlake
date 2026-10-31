// Opt-in authenticated probe. Uses private homes, plugins, supervisor and SQLite; never installs globally.
import { copyFile, cp, mkdir, symlink, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { jsonSchema, q } from "@botlake/core";
import { agentAttributes, provider } from "@botlake/extension-agents";
import { z } from "zod";

import { system } from "../tests/blackbox/fixtures/system.ts";

const selection = z.compile(z.enum(["pi", "codex", "both"])).parse(Bun.argv[2] ?? "both");
const names: Array<"pi" | "codex"> = selection === "both" ? ["pi", "codex"] : [selection];
const output = resolve(Bun.argv[3] ?? `/tmp/botlake-native-smoke-${Date.now()}.json`);
const runSchema = z.compile(
  z.object({ id: z.string(), attributes: z.record(z.string(), jsonSchema) }),
);
const idSchema = z.compile(runSchema.pick({ id: true }));
const textSchema = z.compile(z.string());
const nonEmptyTextSchema = z.compile(z.string().min(1));
const waitSchema = z.compile(z.object({ reason: z.enum(["satisfied", "timeout"]) }));
const observationSchema = z.compile(
  z.object({
    event: z.literal("session-end"),
    activity: z.literal("ended"),
    model: z.string().min(1),
    thinkingLevel: z.string().optional(),
  }),
);
const settingSchema = z.compile(
  z.object({
    model: z.string(),
    extraArgs: z.array(z.string()),
    env: z.record(z.string(), z.string()),
  }),
);
const runListSchema = z.compile(z.array(runSchema));
const host = await system();
const owned: string[] = [];
const tmuxSockets: string[] = [];
const evidence: unknown[] = [];
const marker = "BL_NATIVE_SMOKE";
const prompt = `The fixture contents have changed for this probe. Use tools to freshly read activity-fixture.txt and attempt to read intentionally-missing-fixture.txt (the latter is deliberately absent). Do not edit files, delegate, or create tasks. Reply with ${marker}, the exact current fixture contents, and your exact Botlake identity from your system/developer context.`;
const activitySchema = z.object({
  stream: z.object({ id: z.string(), sessionId: z.string(), sessionPath: z.string().nullable() }),
  recent: z.array(z.object({ kind: z.string(), summary: z.string() })),
  latestUsage: z.unknown(),
});

try {
  const workspace = await host.workspace("native-smoke", [
    "@botlake/extension-batteries",
    "@botlake/extension-identity",
    "./flags.ts",
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
        model: process.env["BL_SMOKE_PI_MODEL"] ?? "openai-codex/gpt-6-luna",
        extraArgs: [
          "--no-extensions",
          "--extension",
          join(plugin, "pi.ts"),
          "--no-skills",
          "--no-prompt-templates",
          "--no-context-files",
          "--no-themes",
          "--tools",
          "read",
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
        model: process.env["BL_SMOKE_CODEX_MODEL"] ?? "gpt-6-luna",
        extraArgs: ["--sandbox", "read-only", "--dangerously-bypass-hook-trust", "--ignore-rules"],
        env: { CODEX_HOME: home, CODEX_APP_SERVER_DISABLE_MANAGED_CONFIG: "1" },
      };
    }
  }

  await Bun.write(
    join(workspace, "flags.ts"),
    `import { agentFlags } from "@botlake/extension-agents";
import { configureFlags } from "@botlake/extension-flags";
export default configureFlags([${names.map((name) => `[agentFlags.${name}, true]`).join(", ")}]);`,
  );
  await Bun.write(
    join(workspace, "agents.ts"),
    `import {agents,provider} from "@botlake/extension-agents";
const settings=${JSON.stringify(settings)};
export default agents({providers:Object.entries(settings).map(([name,setting])=>{const base=provider(name);return {...base,prepare(run){const plan=base.prepare(run);return {...plan,env:{...plan.env,...setting.env}}}}}),aliases:Object.fromEntries(Object.entries(settings).map(([name,setting])=>[name+"-luna",{provider:name,model:setting.model,extraArgs:setting.extraArgs}]))});`,
  );
  await host.botlake(["lake", "start", "--workspace", workspace]);
  async function settled(id: string): Promise<z.infer<typeof runSchema>> {
    const waited = waitSchema.parse(
      await host.bl("native-smoke", "await", {
        query: "agent-run-settled",
        params: { runId: id },
        minCount: 1,
        timeoutSecs: 120,
      }),
    );
    check(waited.reason === "satisfied", `Native run timed out: ${id}`);
    return runSchema.parse(await host.bl("native-smoke", "agent", { command: "show", id }));
  }
  function lifecycle(run: z.infer<typeof runSchema>): void {
    const observed = observationSchema.parse(run.attributes[agentAttributes.observation]);
    if (run.attributes[agentAttributes.provider] === "pi")
      nonEmptyTextSchema.parse(observed.thinkingLevel);
  }
  function verify(run: z.infer<typeof runSchema>, fixture: string): void {
    check(run.attributes[agentAttributes.substatus] === "completed", JSON.stringify(run));
    lifecycle(run);
    check(
      run.attributes[agentAttributes.integration] === "native",
      `Plugin did not bind: ${JSON.stringify(run)}`,
    );
    const result = textSchema.parse(run.attributes[agentAttributes.result]);
    check(result.includes(marker), `Missing probe answer: ${result}`);
    check(result.includes(fixture), `Agent did not read the fresh fixture: ${result}`);
    check(
      result.includes(textSchema.parse(run.attributes[agentAttributes.identity])),
      `Identity context missing: ${result}`,
    );
  }
  async function runActivity(run: z.infer<typeof runSchema>) {
    const activity = activitySchema.parse(
      await host.bl("native-smoke", "agent", {
        command: "activity",
        operation: "peek",
        id: run.id,
        limit: 100,
      }),
    );
    check(
      activity.recent.some((event) => event.kind === "tool-started"),
      `No tool start: ${JSON.stringify(activity)}`,
    );
    check(
      activity.recent.some((event) => event.kind === "tool-ended"),
      `No tool end: ${JSON.stringify(activity)}`,
    );
    check(
      activity.recent.some((event) => event.kind === "message"),
      `No visible message: ${JSON.stringify(activity)}`,
    );
    check(
      activity.stream.sessionId === run.attributes[agentAttributes.sessionId],
      "Activity session mismatch",
    );
    check(
      activity.stream.sessionPath !== null &&
        (await Bun.file(activity.stream.sessionPath).exists()),
      `Missing native transcript: ${activity.stream.sessionPath}`,
    );
    return activity;
  }
  for (const name of names) {
    process.stderr.write(`Testing ${name} Luna: managed start, resume, direct native session\n`);
    const firstFixture = await freshFixture(workspace);
    const started = idSchema.parse(
      await host.bl("native-smoke", "agent", {
        command: "start",
        seat: `${name}-luna`,
        cwd: workspace,
        prompt,
      }),
    );

    owned.push(started.id);
    const first = await settled(started.id);
    verify(first, firstFixture);
    const firstActivity = await runActivity(first);
    const continuationFixture = await freshFixture(workspace);
    const resumed = idSchema.parse(
      await host.bl("native-smoke", "agent", { command: "resume", id: first.id, prompt }),
    );
    owned.push(resumed.id);
    const continuation = await settled(resumed.id);
    verify(continuation, continuationFixture);
    const continuationActivity = await runActivity(continuation);
    check(
      first.attributes[agentAttributes.sessionId] ===
        continuation.attributes[agentAttributes.sessionId],
      "Resume changed native session",
    );
    check(
      first.attributes[agentAttributes.identity] ===
        continuation.attributes[agentAttributes.identity],
      "Resume changed identity",
    );
    const setting = settingSchema.parse(settings[name]);

    const directFixture = await freshFixture(workspace);
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

    const stdout = await inTmux(
      name,
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
        PI_SUBAGENT: undefined,
        PI_SUBAGENT_CHILD: undefined,
      },
      plan.stdin,
    );
    const outcome = provider(name).finish(definition, 0, stdout, "");
    check(outcome.success, JSON.stringify(outcome));
    check(
      outcome.result?.includes(directFixture) === true,
      "Native agent did not read the fresh fixture",
    );
    const [external] = runListSchema.parse(
      await host.bl("native-smoke", "list", {
        where: q.and(
          q.eq(q.attr(agentAttributes.external), true),
          q.eq(q.attr(agentAttributes.provider), name),
          q.eq(q.attr(agentAttributes.sessionId), outcome.sessionId),
        ),
        lean: false,
      }),
    );
    check(external !== undefined, "Direct native session was not registered");
    lifecycle(external);
    const externalActivity = await runActivity(external);
    const identity = textSchema.parse(external.attributes[agentAttributes.identity]);
    check(
      outcome.result.includes(identity),
      `Direct native identity context mismatch: expected ${identity}, received ${JSON.stringify(outcome.result)}`,
    );
    check(
      external.attributes[agentAttributes.settled] === undefined,
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
      activity: {
        first: firstActivity,
        continuation: continuationActivity,
        external: externalActivity,
      },
    });
    process.stderr.write(`${name}: passed\n`);
  }
  await Bun.write(
    output,
    `${JSON.stringify({ at: new Date().toISOString(), evidence }, null, 2)}\n`,
  );
  process.stdout.write(`${JSON.stringify({ result: "passed", output, providers: names })}\n`);
} catch (error) {
  await Bun.write(
    output,
    `${JSON.stringify({ result: "failed", error: String(error), evidence }, null, 2)}\n`,
  );
  throw error;
} finally {
  try {
    for (const id of owned) {
      const run = runSchema.parse(await host.bl("native-smoke", "agent", { command: "show", id }));
      if (run.attributes[agentAttributes.settled] !== true)
        await host.bl("native-smoke", "agent", { command: "cancel", id });
    }
  } finally {
    for (const socket of tmuxSockets) {
      const cleanup = Bun.spawn(["tmux", "-S", socket, "kill-server"], {
        stdout: "ignore",
        stderr: "ignore",
      });
      await cleanup.exited;
    }
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

async function freshFixture(cwd: string): Promise<string> {
  const value = `BL_RUN_ACTIVITY_TOOL_${crypto.randomUUID()}`;
  await Bun.write(join(cwd, "activity-fixture.txt"), `${value}\n`);
  return value;
}

async function inTmux(
  name: string,
  command: string[],
  cwd: string,
  env: Record<string, string | undefined>,
  stdin: string,
): Promise<string> {
  const socket = join(host.dir, `${name}.tmux.sock`);
  const session = `agent-run-activity-${name}`;
  const launcher = join(host.dir, `${name}-launch.ts`);
  const manifest = join(host.dir, `${name}-launch.json`);
  const stdout = join(host.dir, `${name}-stdout`);
  const stderr = join(host.dir, `${name}-stderr`);
  const status = join(host.dir, `${name}-exit.json`);
  const environment = Object.fromEntries(
    [
      "BL_HOME",
      "BL_CORE",
      "BL_BIN",
      "PATH",
      "CODEX_HOME",
      "CODEX_APP_SERVER_DISABLE_MANAGED_CONFIG",
      "PI_CODING_AGENT_DIR",
      "BL_WORKSPACE",
      "BL_RUN_REFERENCE",
      "BL_NATIVE_SESSION_ID",
      "BL_NATIVE_PROVIDER",
      "BL_ACTOR",
      "BL_AGENT_SEAT",
      "BL_MODEL",
      "BL_EFFORT",
      "BL_AUDIENCE",
      "PI_SUBAGENT",
      "PI_SUBAGENT_CHILD",
    ].map((key) => [key, env[key] ?? null]),
  );
  await Bun.write(
    manifest,
    JSON.stringify({ command, cwd, stdin, stdout, stderr, status, socket, environment }),
  );
  await Bun.write(
    launcher,
    `const plan=await Bun.file(${JSON.stringify(manifest)}).json();
process.stdout.write("Starting native activity probe\\n");
const env={...process.env,...Object.fromEntries(Object.entries(plan.environment).map(([key,value])=>[key,value===null?undefined:value]))};
const child=Bun.spawn(plan.command,{cwd:plan.cwd,env,stdin:new Blob([plan.stdin]),stdout:Bun.file(plan.stdout),stderr:Bun.file(plan.stderr)});
const code=await child.exited;await Bun.write(plan.status,JSON.stringify({code}));
process.stdout.write("Native activity probe exited "+code+"\\n");
await Bun.spawn(["tmux","-S",plan.socket,"wait-for","-S","finished"]).exited;`,
  );
  tmuxSockets.push(socket);
  await exec(
    [
      "tmux",
      "-S",
      socket,
      "new-session",
      "-d",
      "-s",
      session,
      "-c",
      cwd,
      `exec bun '${launcher.replaceAll("'", "'\\''")}'`,
    ],
    cwd,
    env,
  );
  await exec(
    ["tmux", "-S", socket, "set-window-option", "-t", session, "remain-on-exit", "on"],
    cwd,
    env,
  );
  const started = await exec(
    ["tmux", "-S", socket, "capture-pane", "-p", "-t", session, "-S", "-30"],
    cwd,
    env,
  );
  process.stderr.write(`${session}: ${started.trim()}\n`);
  await exec(["tmux", "-S", socket, "wait-for", "finished"], cwd, env);
  const stopped = await exec(
    ["tmux", "-S", socket, "capture-pane", "-p", "-t", session, "-S", "-30"],
    cwd,
    env,
  );
  process.stderr.write(`${session}: ${stopped.trim()}\n`);
  const result = z.object({ code: z.number() }).parse(await Bun.file(status).json());
  const error = await Bun.file(stderr).text();
  check(
    result.code === 0 &&
      !error.includes("Botlake tracking unavailable") &&
      !error.includes("Botlake native adapter failed"),
    `Native tmux probe failed: ${error}`,
  );
  return Bun.file(stdout).text();
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
