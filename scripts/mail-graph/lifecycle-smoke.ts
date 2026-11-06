// oxlint-disable import/max-dependencies -- This smoke composes the selected public extensions.
// Real disposable SQLite, public operations and injected custody; no model calls.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ManualClock, Runtime, type ProcessFact, type Processes } from "@botlake/core";
import {
  agents,
  agentAttributes as a,
  agentFlags,
  agentRelations,
  provider,
} from "@botlake/extension-agents";
import { configureFlags } from "@botlake/extension-flags";
import { identity } from "@botlake/extension-identity";
import { mail } from "@botlake/extension-mail";
import { mailAgents, mailAgentAttributes } from "@botlake/extension-mail-agents";
import { z } from "zod";

const dir = await mkdtemp(join(tmpdir(), "botlake-mail-lifecycle-"));
const clock = new ManualClock();
const facts = new Map<string, ProcessFact>();
const output = { stdout_ref: join(dir, "stdout"), stderr_ref: join(dir, "stderr") };
await Bun.write(output.stdout_ref, "");
await Bun.write(output.stderr_ref, "");
const processes: Processes = {
  async listOwned() {
    return [...facts.values()];
  },
  async launch(spec) {
    const fact: ProcessFact = {
      owner: spec.owner,
      key: spec.key,
      handle: spec.key,
      phase: "running",
      output,
    };
    facts.set(fact.handle, fact);
    return fact;
  },
  async get(handle) {
    return z.custom<ProcessFact>((v) => v !== undefined).parse(facts.get(handle));
  },
  async cancel(handle) {
    const fact = facts.get(handle);
    assert.ok(fact !== undefined);
    const stopped: ProcessFact = {
      ...fact,
      phase: "terminal",
      exit: { code: 1, signal: "SIGTERM" },
    };
    facts.set(handle, stopped);
    return stopped;
  },
  async acknowledge() {},
};
const identifier = z.object({ id: z.string() });
const waiting = z.object({
  id: z.string(),
  status: z.string(),
  continuation: z.string().optional(),
});
let binding = configuredAgents();
let runtime = new Runtime({ database: join(dir, "lake.sqlite"), workspace: dir, clock, processes });
try {
  const missing = new Runtime({ database: ":memory:" });
  await assert.rejects(missing.start([mailAgents({ agents: binding })]), /requires/u);
  await missing.stop();
  await open();
  const cold = binding
    .instance(runtime.context)
    .start({ seat: "worker", cwd: dir, prompt: "unverified" });
  await assert.rejects(
    runtime.invoke("mail-agent", { command: "arm", run: cold.id }, { identity: "invented" }),
    /verified/u,
  );
  await runtime.invoke("agent", { command: "cancel", id: cold.id });

  const active = await start("main");
  await assert.rejects(
    runtime.invoke("mail-agent", { command: "arm", run: active.id }, { identity: "other" }),
    /verified/u,
  );
  const wait = await arm(active);
  assert.deepEqual(await arm(active), wait, "Repeated arm retains the original permission");
  assert.throws(
    () =>
      runtime.graph.setAttributes(wait.id, {
        [mailAgentAttributes.state]: { status: "cancelled" },
      }),
    /API/u,
  );
  const readFirst = await send(active.identity);
  await poll();
  assert.equal(children(active.id).length, 0, "Mail cannot resume a live writer");
  await runtime.invoke("mail", { command: "ack", id: readFirst }, { identity: active.identity });
  await finish(active.id);
  await poll();
  assert.equal(children(active.id).length, 0, "Acknowledged mail does not qualify");
  await send(active.identity);
  await send(active.identity);
  await restart();
  const resumed = await show(wait.id);
  assert.equal(resumed.status, "resumed");
  assert.equal(children(active.id).length, 1, "Startup coalesces pending mail into one admission");
  await restart();
  await poll();
  assert.equal(children(active.id).length, 1, "Restart must not replay the consumed permission");
  const continuation = z.string().parse(resumed.continuation);
  await finish(continuation);
  await send(active.identity);
  await poll();
  assert.equal(children(continuation).length, 0, "A resumed run must opt in again");

  const ordinary = await start("ordinary");
  await finish(ordinary.id);
  await send(ordinary.identity);
  await poll();
  assert.equal(children(ordinary.id).length, 0, "Finished sessions are not automatically enrolled");

  const cancelled = await start("cancelled-wait");
  const cancelledWait = await arm(cancelled);
  await runtime.invoke(
    "mail-agent",
    { command: "cancel", id: cancelledWait.id },
    { identity: cancelled.identity },
  );
  await finish(cancelled.id);
  await send(cancelled.identity);
  await poll();
  assert.equal((await show(cancelledWait.id)).status, "cancelled");
  assert.equal(children(cancelled.id).length, 0);

  const expiring = await start("expiry");
  const expired = await arm(expiring, 1);
  await finish(expiring.id);
  await send(expiring.identity);
  await poll();
  assert.equal((await show(expired.id)).status, "expired");
  assert.equal(children(expiring.id).length, 0);

  const failed = await start("failed");
  const failedWait = await arm(failed);
  await finish(failed.id, 1);
  await send(failed.identity);
  await poll();
  assert.equal((await show(failedWait.id)).status, "failed");
  assert.equal(children(failed.id).length, 0, "Failed execution is not retried by Mail");

  await runtime.invoke("agent", { command: "retry", id: failed.id });
  await binding.instance(runtime.context).reconcile();
  await runtime.invoke("agent", {
    command: "native",
    provider: "codex",
    nativeSessionId: "failed",
    cwd: dir,
    event: "agent-start",
    runId: failed.id,
    invocation: z.string().parse(runtime.graph.show(failed.id).attributes[a.invocation]),
  });
  const retryWait = await arm(failed);
  assert.notEqual(
    retryWait.id,
    failedWait.id,
    "A retried invocation may explicitly arm a new permission",
  );
  await finish(failed.id);
  await poll();
  assert.equal((await show(retryWait.id)).status, "resumed");
  assert.equal((await show(failedWait.id)).status, "failed");

  const target = runtime.graph.add({ title: "Assigned task" });
  const closed = await start("closed-task", target.id);
  const closedWait = await arm(closed);
  await finish(closed.id);
  runtime.graph.update(target.id, { state: "closed" });
  await send(closed.identity);
  await poll();
  assert.equal((await show(closedWait.id)).status, "failed");
  assert.equal(children(closed.id).length, 0, "Agents rejects admission for completed targets");

  const competing = await start("manual-resume");
  const competingWait = await arm(competing);
  await finish(competing.id);
  binding.instance(runtime.context).resume(competing.id, "manual continuation");
  await send(competing.identity);
  await poll();
  assert.equal((await show(competingWait.id)).status, "failed");
  assert.equal(
    children(competing.id).length,
    1,
    "Manual and automatic continuations cannot duplicate writers",
  );
  const failedRevision = runtime.graph.show(competingWait.id).revision;
  await poll();
  assert.equal(
    runtime.graph.show(competingWait.id).revision,
    failedRevision,
    "Admission failures stay latched",
  );
  assert.deepEqual(runtime.errors, []);
  console.log(
    JSON.stringify({
      passed: true,
      checks: [
        "typed binding",
        "explicit running identity",
        "settlement before resume",
        "acknowledged mail excluded",
        "startup/restart coalescing",
        "no implicit rearm",
        "cancel",
        "expiry",
        "failed execution",
        "explicit retry enrollment",
        "closed task",
        "competing continuation",
        "latched failures",
      ],
    }),
  );
} finally {
  await runtime.stop();
  await rm(dir, { recursive: true, force: true });
}

function configuredAgents() {
  return agents({
    providers: [
      {
        ...provider("codex"),
        prepare: () => ({ command: ["fixture"], stdin: "", env: {} }),
        finish: (run, code) => ({
          success: code === 0,
          result: "fixture",
          error: code === 0 ? null : "fixture failure",
          sessionId: run.resumes ? run.sessionId : run.prompt,
        }),
      },
    ],
    aliases: { worker: { parent: "codex" } },
  });
}
async function open() {
  await runtime.start([
    configureFlags([[agentFlags.codex, true]]),
    identity(),
    binding,
    mail(),
    mailAgents({ agents: binding }),
  ]);
}
async function restart() {
  await runtime.stop();
  binding = configuredAgents();
  runtime = new Runtime({ database: join(dir, "lake.sqlite"), workspace: dir, clock, processes });
  await open();
}
async function start(name: string, target?: string) {
  const run = binding
    .instance(runtime.context)
    .start({ seat: "worker", cwd: dir, prompt: name, ...(target === undefined ? {} : { target }) });
  await binding.instance(runtime.context).reconcile();
  const invocation = z.string().parse(runtime.graph.show(run.id).attributes[a.invocation]);
  const observed = z.object({ identity: z.string() }).parse(
    await runtime.invoke("agent", {
      command: "native",
      provider: "codex",
      nativeSessionId: name,
      cwd: dir,
      event: "agent-start",
      runId: run.id,
      invocation,
    }),
  );
  return { id: run.id, identity: observed.identity };
}
async function finish(id: string, code = 0) {
  await binding.instance(runtime.context).reconcile();
  const handle = z.string().parse(runtime.graph.show(id).attributes[a.handle]);
  const fact = facts.get(handle);
  assert.ok(fact !== undefined);
  facts.set(handle, { ...fact, phase: "terminal", exit: { code, signal: null } });
  await binding.instance(runtime.context).reconcile();
}
async function poll() {
  clock.advance(clock.now() + 1000);
  await runtime.drain();
}
async function arm(run: { id: string; identity: string }, timeoutSecs = 300) {
  return waiting.parse(
    await runtime.invoke(
      "mail-agent",
      { command: "arm", run: run.id, timeoutSecs },
      { identity: run.identity },
    ),
  );
}
async function show(id: string) {
  return waiting.parse(
    await runtime.invoke("mail-agent", { command: "show", id }, { identity: "observer" }),
  );
}
async function send(to: string) {
  return identifier.parse(
    await runtime.invoke(
      "mail",
      { command: "send", to, subject: "Resume", body: "Check mail" },
      { identity: "sender" },
    ),
  ).id;
}
function children(id: string) {
  return runtime.graph.edges(id, agentRelations.continues).filter((e) => e.to_id === id);
}
