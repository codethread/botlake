import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { system } from "../../tests/blackbox/fixtures/system.ts";
import { call, root } from "./fixture.ts";

const output = join(
  root,
  "out/mail-graph/lifecycle-live",
  new Date().toISOString().replaceAll(":", "-"),
);
await mkdir(output, { recursive: true });
const fixture = await system();
const node = z.object({ id: z.string(), attributes: z.record(z.string(), z.json()) });
try {
  const workspace = await fixture.workspace("mail-resume", [
    "@botlake/extension-batteries",
    "@botlake/extension-identity",
    "./flags.ts",
    "./agents.ts",
    "@botlake/extension-mail",
    "./mail-agents.ts",
  ]);
  const identityHook = `bun '${join(root, "plugins/identity/hook.ts")}' codex`;
  const mailHook = `bun '${join(root, "plugins/mail/hook.ts")}' codex`;
  const hooks = (commands: string[]) =>
    `[{ hooks = [${commands.map((command) => `{type="command",command=${JSON.stringify(command)},timeout=10,additionalContextLimit=4096}`).join(",")}] }]`;
  const codexArgs = [
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "--dangerously-bypass-hook-trust",
    "--dangerously-bypass-approvals-and-sandbox",
    "-c",
    "features.hooks=true",
    "-c",
    `hooks.SessionStart=${hooks([identityHook, mailHook])}`,
    "-c",
    `hooks.PostToolUse=${hooks([mailHook])}`,
  ];
  const piArgs = [
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--no-mcp",
    "-e",
    join(root, "plugins/identity/pi.ts"),
    "-e",
    join(root, "plugins/mail/pi.ts"),
  ];
  await Bun.write(
    join(workspace, "flags.ts"),
    `import {configureFlags} from '@botlake/extension-flags'; import {agentFlags} from '@botlake/extension-agents'; export default configureFlags([[agentFlags.codex,true],[agentFlags.pi,true]]);`,
  );
  await Bun.write(
    join(workspace, "agents.ts"),
    `import {agents,builtinProviders,agentFlags} from '@botlake/extension-agents';
const codex=builtinProviders.codex({flag:agentFlags.codex}), pi=builtinProviders.pi({flag:agentFlags.pi});
export default agents({providers:[{...codex,prepare(run){const p=codex.prepare(run);return {...p,command:[p.command[0],'--no-daemon',...p.command.slice(1)],env:{...p.env,BL_BIN:${JSON.stringify(fixture.blBin)}}};}},{...pi,prepare(run){const p=pi.prepare(run);return {...p,command:[${JSON.stringify(process.env["BL_MAIL_PI_BIN"] ?? "pi")},...p.command.slice(1)],env:{...p.env,BL_BIN:${JSON.stringify(fixture.blBin)}}};}}],aliases:{'luna-codex':{parent:'codex',model:'gpt-6-luna',effort:'low',extraArgs:${JSON.stringify(codexArgs)}},'luna-pi':{parent:'pi',model:'openai-codex/gpt-6-luna',effort:'low',extraArgs:${JSON.stringify(piArgs)}}}});`,
  );
  await Bun.write(
    join(workspace, "mail-agents.ts"),
    `import {mailAgents} from '@botlake/extension-mail-agents'; import agents from './agents.ts'; export default mailAgents({agents});`,
  );
  await fixture.botlake(["lake", "start", "--workspace", workspace]);
  const trials = await Promise.allSettled(
    ["codex", "pi"].map(async (provider) => {
      const cwd = join(workspace, provider);
      await mkdir(cwd);
      const prompt =
        "This is a disposable managed-session mail test. Use your actual identity from startup. Load prime mail and prime mail-agent. In this first turn, arm your current run for 180 seconds using mail-agent arm; RUN_ID is the part of BL_RUN_REFERENCE before the colon. Save the JSON response to armed.json in this directory, then finish immediately without polling or waiting. Your task is still awaiting mail. On a later continuation, read and acknowledge incoming mail, write its exact body to result.txt (trailing newline is okay), then finish without arming again. Do not delegate or inspect implementation files.";
      const first = z.object({ id: z.string() }).parse(
        await call(fixture, workspace, "test", "agent", {
          command: "start",
          seat: `luna-${provider}`,
          cwd,
          prompt,
        }),
      );
      await settled(first.id);
      const original = node.parse(
        await call(fixture, workspace, "test", "agent", { command: "show", id: first.id }),
      );
      await Bun.write(join(output, `${provider}-original.json`), JSON.stringify(original, null, 2));
      assert.equal(original.attributes["agent/lifecycle"], "completed");
      const identity = z.string().parse(original.attributes["agent/identity"]);
      const wait = z
        .object({ id: z.string(), status: z.literal("armed") })
        .parse(await Bun.file(join(cwd, "armed.json")).json());
      assert.equal(
        z.object({ status: z.string() }).parse(
          await call(fixture, workspace, "test", "mail-agent", {
            command: "show",
            id: wait.id,
          }),
        ).status,
        "armed",
      );
      const token = crypto.randomUUID();
      const message = z.object({ id: z.string() }).parse(
        await call(fixture, workspace, "sender", "mail", {
          command: "send",
          to: identity,
          subject: "Continue",
          body: token,
          urgent: true,
        }),
      );
      const observed = z.object({ reason: z.literal("satisfied") }).parse(
        await call(fixture, workspace, "test", "await", {
          query: "mail-agent-wait-settled",
          params: { id: wait.id },
          minCount: 1,
          timeoutSecs: 20,
        }),
      );
      assert.equal(observed.reason, "satisfied");
      const resumed = z
        .object({ status: z.literal("resumed"), continuation: z.string() })
        .parse(
          await call(fixture, workspace, "test", "mail-agent", { command: "show", id: wait.id }),
        );
      await settled(resumed.continuation);
      const continuation = node.parse(
        await call(fixture, workspace, "test", "agent", {
          command: "show",
          id: resumed.continuation,
        }),
      );
      await Bun.write(
        join(output, `${provider}-continuation.json`),
        JSON.stringify(continuation, null, 2),
      );
      assert.equal(continuation.attributes["agent/lifecycle"], "completed");
      assert.equal(
        continuation.attributes["agent/session-id"],
        original.attributes["agent/session-id"],
      );
      assert.equal(continuation.attributes["agent/identity"], identity);
      const body = (await Bun.file(join(cwd, "result.txt")).text()).trim();
      assert.equal(body, token);
      const detail = z
        .object({ status: z.literal("acknowledged") })
        .parse(
          await call(fixture, workspace, identity, "mail", { command: "read", id: message.id }),
        );
      return {
        provider,
        first: first.id,
        continuation: continuation.id,
        sameSession: true,
        identity,
        bodyMatches: true,
        status: detail.status,
      };
    }),
  );
  const results = trials.map((trial) =>
    trial.status === "fulfilled" ? trial.value : { error: String(trial.reason) },
  );
  await Bun.write(join(output, "results.json"), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ output, results }));
  assert.ok(trials.every((trial) => trial.status === "fulfilled"));

  async function settled(runId: string) {
    z.object({ reason: z.literal("satisfied") }).parse(
      await call(fixture, workspace, "test", "await", {
        query: "agent-run-settled",
        params: { runId },
        minCount: 1,
        timeoutSecs: 120,
      }),
    );
  }
} finally {
  await fixture.close();
  await Bun.write(join(output, "cleanup.json"), JSON.stringify({ removed: fixture.dir }));
}
