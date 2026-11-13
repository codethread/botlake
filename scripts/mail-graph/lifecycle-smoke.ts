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
  builtinProviders,
} from "@botlake/extension-agents";
import { configureFlags } from "@botlake/extension-flags";
import { identity } from "@botlake/extension-identity";
import { mail, mailAttributes } from "@botlake/extension-mail";
import { mailAgents } from "@botlake/extension-mail-agents";
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
      cancellation: { reason: "cancelled", stop: "confirmed" },
    };
    facts.set(handle, stopped);
    return stopped;
  },
  async acknowledge() {},
};
const identifier = z.object({ id: z.string() });
let graceSecs = 300;
let mailbox = mail();
let binding = configuredAgents();
let runtime = new Runtime({ database: join(dir, "lake.sqlite"), workspace: dir, clock, processes });
try {
  const missing = new Runtime({ database: ":memory:" });
  await assert.rejects(
    missing.start([mailAgents({ agents: binding, mail: mailbox })]),
    /requires/u,
  );
  await missing.stop();
  await open();
  const inactive = await send("no-agent");
  assert.equal((await read(inactive)).status, "undeliverable");
  assert.equal((await read(inactive)).reason, "recipient_inactive");

  const active = await start("main");
  const readFirst = await send(active.identity);
  await poll();
  assert.equal(children(active.id).length, 0, "Mail cannot resume a live writer");
  await runtime.invoke("mail", { command: "ack", id: readFirst }, { identity: active.identity });
  await finish(active.id);
  const firstStop = runtime.graph.show(active.id).attributes[a.stoppedAt];
  assert.equal(firstStop, clock.now(), "Agents records settled stop time");
  await poll();
  assert.equal(runtime.graph.show(active.id).attributes[a.stoppedAt], firstStop);
  assert.equal(children(active.id).length, 0, "Acknowledged mail does not qualify");
  const first = await send(active.identity);
  const second = await send(active.identity);
  assert.equal((await read(first)).status, "sent", "Resume admission is not delivery");
  await restart();
  assert.equal(children(active.id).length, 1, "Arrivals coalesce into one continuation");
  const continuation = child(active.id);
  assert.equal(runtime.graph.show(first).attributes[mailAttributes.wakeRun], continuation);
  await runtime.invoke(
    "mail",
    { command: "delivered", ids: [second] },
    { identity: active.identity },
  );
  await finish(continuation);
  await restart();
  await poll();
  assert.equal(children(continuation).length, 0, "Old unacknowledged mail never wakes twice");
  await send(active.identity);
  assert.equal(children(continuation).length, 1, "Each normal stop automatically renews grace");

  const during = await start("arrives-before-stop");
  const pending = await send(during.identity);
  await send(during.identity);
  await finish(during.id);
  await restart();
  assert.equal(children(during.id).length, 1, "Startup wakes for mail received before settlement");
  const duringChild = child(during.id);
  assert.equal(runtime.graph.show(pending).attributes[mailAttributes.wakeRun], duringChild);
  await finish(duringChild);
  await poll();
  assert.equal(children(duringChild).length, 0, "A whole pending batch is consumed by one wake");

  const notified = await start("notified");
  const notifiedMail = await send(notified.identity);
  await runtime.invoke(
    "mail",
    { command: "delivered", ids: [notifiedMail] },
    { identity: notified.identity },
  );
  await finish(notified.id);
  await poll();
  assert.equal(children(notified.id).length, 0, "Already announced mail is not a new wake");

  const long = await start("long-running");
  clock.advance(clock.now() + 600_000);
  await finish(long.id);
  await send(long.identity);
  assert.equal(children(long.id).length, 1, "Grace starts at stop, not launch or enrollment");

  const expiring = await start("expiry");
  await finish(expiring.id);
  clock.advance(clock.now() + 300_000);
  const expired = await send(expiring.identity);
  assert.equal(
    (await read(expired)).status,
    "undeliverable",
    "Grace expires at the exact deadline",
  );
  assert.equal(children(expiring.id).length, 0);
  assert.equal(
    z
      .object({ messages: z.array(z.unknown()) })
      .parse(await runtime.invoke("mail", { command: "inbox" }, { identity: expiring.identity }))
      .messages.length,
    0,
    "Undeliverable mail is dropped from the live inbox",
  );
  await assert.rejects(
    runtime.invoke("mail", { command: "ack", id: expired }, { identity: expiring.identity }),
    /Undeliverable/u,
  );
  await assert.rejects(
    runtime.invoke(
      "mail",
      { command: "delivered", ids: [expired] },
      { identity: expiring.identity },
    ),
    /Undeliverable/u,
  );

  const failed = await start("failed");
  await finish(failed.id, 1);
  assert.equal((await read(await send(failed.identity))).status, "undeliverable");
  assert.equal(children(failed.id).length, 0, "Mail never retries failed execution");
  await runtime.invoke("agent", { command: "retry", id: failed.id });
  assert.equal(
    runtime.graph.show(failed.id).attributes[a.stoppedAt],
    undefined,
    "Retry clears the previous stop",
  );
  await finish(failed.id);
  await send(failed.identity);
  assert.equal(children(failed.id).length, 1, "A successful retry is reachable without enrollment");

  const cancelled = await start("cancelled");
  await runtime.invoke("agent", { command: "cancel", id: cancelled.id });
  assert.equal(runtime.graph.show(cancelled.id).attributes[a.lifecycle], "cancelled");
  assert.equal((await read(await send(cancelled.identity))).status, "undeliverable");
  assert.equal(children(cancelled.id).length, 0);

  const target = runtime.graph.add({ title: "Assigned task" });
  const closed = await start("closed-task", target.id);
  await finish(closed.id);
  runtime.graph.update(target.id, { state: "closed" });
  const rejected = await send(closed.identity);
  assert.equal((await read(rejected)).reason, "resume_rejected");
  assert.equal(children(closed.id).length, 0, "Agents still owns task admission");
  const revision = runtime.graph.show(rejected).revision;
  await poll();
  assert.equal(runtime.graph.show(rejected).revision, revision, "Delivery failures are terminal");

  const competing = await start("manual-resume");
  await finish(competing.id);
  const manual = binding.instance(runtime.context).resume(competing.id, "manual continuation");
  await send(competing.identity);
  assert.equal(
    children(competing.id).length,
    1,
    "Mail follows an admitted continuation rather than duplicating it",
  );
  await finish(manual.id);
  await poll();
  assert.equal(children(manual.id).length, 1, "Unannounced mail can wake after a manual run stops");

  const external = await start("external-writer");
  await finish(external.id);
  await observeExternal("external-writer", "agent-start");
  assert.throws(
    () => binding.instance(runtime.context).resume(external.id, "competing resume"),
    /active writer/u,
  );
  const externalMail = await send(external.identity);
  assert.equal((await read(externalMail)).status, "sent");
  await observeExternal("external-writer", "agent-end");
  await poll();
  assert.equal(children(external.id).length, 0, "Idle external turns retain session custody");
  await observeExternal("external-writer", "session-end");
  await poll();
  assert.equal(children(external.id).length, 1, "Only session end permits managed continuation");
  const missed = await start("missed-window");
  const missedMail = await send(missed.identity);
  await finish(missed.id);
  clock.advance(clock.now() + 300_000);
  await restart();
  assert.equal(
    (await read(missedMail)).status,
    "undeliverable",
    "No catch-up wake after grace expires",
  );

  graceSecs = 2;
  await restart();
  const custom = await start("custom-grace");
  await finish(custom.id);
  clock.advance(clock.now() + 1999);
  await send(custom.identity);
  assert.equal(children(custom.id).length, 1, "Configured grace is honored before its deadline");
  const customExpired = await start("custom-expiry");
  await finish(customExpired.id);
  clock.advance(clock.now() + 2000);
  assert.equal((await read(await send(customExpired.identity))).status, "undeliverable");

  graceSecs = 0;
  await restart();
  const liveOnly = await start("live-only");
  const liveMail = await send(liveOnly.identity);
  assert.equal((await read(liveMail)).status, "sent");
  await finish(liveOnly.id);
  assert.equal(
    (await read(await send(liveOnly.identity))).status,
    "undeliverable",
    "Zero grace keeps live delivery only",
  );
  assert.deepEqual(runtime.errors, []);
  console.log(
    JSON.stringify({
      passed: true,
      checks: [
        "typed composition",
        "inactive recipient",
        "automatic and configured grace",
        "recorded stop time",
        "settlement before resume",
        "arrival/settlement order",
        "coalescing and restart",
        "no repeated wakes",
        "delivered/acknowledged exclusion",
        "terminal undeliverable",
        "retry stop reset",
        "cancelled and failed runs",
        "closed task",
        "manual continuation",
        "external session custody",
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
        ...builtinProviders.codex({ flag: agentFlags.codex }),
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
    mailbox,
    mailAgents({ agents: binding, mail: mailbox, graceSecs }),
  ]);
}
async function restart() {
  await runtime.stop();
  binding = configuredAgents();
  mailbox = mail();
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
async function read(id: string) {
  return z
    .object({ status: z.string(), reason: z.string().optional() })
    .parse(await runtime.invoke("mail", { command: "read", id }, { identity: "observer" }));
}
function child(id: string) {
  return z.string().parse(children(id)[0]?.from_id);
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

async function observeExternal(
  nativeSessionId: string,
  event: "agent-start" | "agent-end" | "session-end",
) {
  await runtime.invoke("agent", {
    command: "native",
    provider: "codex",
    nativeSessionId,
    cwd: dir,
    event,
  });
}
