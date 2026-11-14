// Run: bun scripts/work-auto-bot-smoke.ts — disposable SQLite and packed CLI; no live model calls.
// oxlint-disable import/max-dependencies -- This smoke composes the selected public extensions.
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ManualClock,
  Runtime,
  type Attributes,
  type ProcessFact,
  type Processes,
} from "@botlake/core";
import {
  agentAttributes,
  agentFlags,
  agentRelations,
  agents,
  builtinProviders,
} from "@botlake/extension-agents";
import { configureFlags } from "@botlake/extension-flags";
import { identity } from "@botlake/extension-identity";
import { mail } from "@botlake/extension-mail";
import { mailAgents } from "@botlake/extension-mail-agents";
import { work } from "@botlake/extension-work";
import { workAgents } from "@botlake/extension-work-agents";
import { workAutoBot, workAutoBotAttributes as attrs } from "@botlake/extension-work-auto-bot";
import { z } from "zod";

import { system } from "../tests/blackbox/fixtures/system.ts";

const identifier = z.object({ id: z.string() });
const optedIn = { [attrs.autoRun]: true, [attrs.seat]: "worker" };

async function directPhase(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "botlake-work-auto-bot-"));
  const clock = new ManualClock();
  const facts = new Map<string, ProcessFact>();
  let launches = 0;
  let preparationFails = false;
  let launchFails = false;
  let missingSession = false;
  let runtime: Runtime | undefined;
  let agentsBinding: ReturnType<typeof agents> | undefined;
  let workBinding: ReturnType<typeof work> | undefined;
  const output = { stdout_ref: join(dir, "stdout"), stderr_ref: join(dir, "stderr") };
  await Bun.write(output.stdout_ref, "");
  await Bun.write(output.stderr_ref, "");
  const processes: Processes = {
    async listOwned() {
      return [...facts.values()];
    },
    async launch(spec) {
      launches++;
      const fact: ProcessFact = {
        owner: spec.owner,
        key: spec.key,
        handle: spec.key,
        phase: "running",
        output,
        ...(launchFails
          ? { phase: "terminal", launch_failure: { message: "fixture launch failure" } }
          : {}),
      };
      facts.set(fact.handle, fact);
      return fact;
    },
    async get(handle) {
      const fact = facts.get(handle);
      assert.ok(fact !== undefined);
      return fact;
    },
    async cancel() {
      throw new Error("Smoke does not cancel processes");
    },
    async acknowledge() {},
  };

  async function open(enabled = true): Promise<Runtime> {
    const next = new Runtime({
      database: join(dir, "lake.sqlite"),
      workspace: dir,
      clock,
      processes,
    });
    const codex = builtinProviders.codex({ flag: agentFlags.codex });
    agentsBinding = agents({
      providers: [
        {
          ...codex,
          prepare() {
            if (preparationFails) throw new Error("fixture preparation failure");
            return { command: ["fixture-agent"], stdin: "", env: {} };
          },
          finish: (definition) => ({
            success: true,
            result: "fixture completed, not task success",
            error: null,
            sessionId: missingSession
              ? null
              : definition.resumes
                ? definition.sessionId
                : `smoke-${definition.prompt.match(/Work assigned task (\S+)\./u)?.[1] ?? definition.prompt}`,
          }),
        },
      ],
      aliases: {
        worker: {
          parent: "codex",
          model: "fixture-model",
          systemPrompt() {
            assert.equal(
              next.graph.inTransaction,
              true,
              "Admission must remain synchronous/atomic",
            );
            return "configured worker";
          },
        },
        unavailable: { parent: "claude" },
        oracle: { parent: "worker" },
      },
    });
    workBinding = work();
    const autoBot = workAutoBot({ agents: agentsBinding, work: workBinding });
    const mailBinding = mail();
    assert.deepEqual(autoBot.requires, [workBinding.name, agentsBinding.name]);
    await next.start([
      configureFlags([[agentFlags.codex, true]]),
      identity(),
      agentsBinding,
      workBinding,
      workAgents({ checkIntervalMs: 1000 }),
      mailBinding,
      mailAgents({ agents: agentsBinding, mail: mailBinding }),
      ...(enabled ? [autoBot] : []),
    ]);
    return next;
  }

  try {
    const unselected = new Runtime({ database: ":memory:" });
    const unselectedAgents = agents();
    const unselectedWork = work();
    assert.throws(() => unselectedAgents.instance(unselected.context), /not activated/u);
    assert.throws(() => unselectedWork.instance(unselected.context), /not activated/u);
    await assert.rejects(
      unselected.start([workAutoBot({ agents: unselectedAgents, work: unselectedWork })]),
      /requires/u,
    );

    const mismatched = new Runtime({ database: ":memory:" });
    const expectedAgents = agents();
    const expectedWork = work();
    await assert.rejects(
      mismatched.start([
        configureFlags([[agentFlags.codex, true]]),
        identity(),
        agents(),
        work(),
        workAutoBot({ agents: expectedAgents, work: expectedWork }),
      ]),
      /exact binding/u,
    );
    await mismatched.stop();

    runtime = await open(false);
    async function create(
      title: string,
      attributes: Attributes = optedIn,
      fields: Record<string, unknown> = {},
    ) {
      assert.ok(runtime !== undefined);
      const { id } = identifier.parse(
        await runtime.invoke("work", { command: "create", title, by: "smoke", ...fields }),
      );
      runtime.graph.setAttributes(id, attributes);
      return id;
    }
    function runs(task: string) {
      assert.ok(runtime !== undefined);
      assert.ok(agentsBinding !== undefined);
      return agentsBinding
        .instance(runtime.context)
        .runs()
        .filter((run) => runtime?.graph.edge(run.id, task, agentRelations.serves) !== null);
    }
    async function poll() {
      assert.ok(runtime !== undefined);
      const wake = runtime.scheduler.pending().find((entry) => entry.key === "work-auto-bot/scan");
      assert.ok(wake !== undefined);
      clock.advance(wake.at);
      await runtime.drain();
      await runtime.invoke("agent", { command: "reconcile" });
      await runtime.drain();
    }

    const admitted = await create("Admission on startup");
    assert.equal(runs(admitted).length, 0, "Import/install alone must be inert");
    await runtime.stop();
    runtime = await open();
    assert.equal(runs(admitted).length, 1);
    assert.equal(launches, 0);
    await runtime.stop();
    runtime = await open();
    assert.equal(runs(admitted).length, 1, "Restart must not duplicate a pending admission");
    const run = runs(admitted)[0];
    assert.ok(run !== undefined);
    assert.equal(run.attributes[agentAttributes.cwd], realpathSync(dir));
    assert.equal(run.attributes[agentAttributes.seat], "worker");
    assert.equal(run.attributes[agentAttributes.requestId], `work-auto-bot/${admitted}`);
    assert.equal(
      z
        .object({ model: z.literal("fixture-model") })
        .parse(run.attributes[agentAttributes.settings]).model,
      "fixture-model",
    );
    const prompt = z.string().parse(run.attributes[agentAttributes.prompt]);
    for (const phrase of [
      admitted,
      "assignment.id",
      "Oracle",
      "unplanned HITL prerequisite",
      "release only your exact assignment",
      "authored workflow outcome",
      "close the satisfied task",
    ])
      assert.ok(prompt.includes(phrase), `Missing worker guidance: ${phrase}`);

    const untouched = [
      await create("No opt-in", {}),
      await create("String is not boolean", { ...optedIn, [attrs.autoRun]: "true" }),
      await create("HITL", optedIn, { audience: "HITL" }),
      await create("Assigned", optedIn, { assignee: "someone" }),
      await create("Group", optedIn, { kind: "group" }),
    ];
    const closed = await create("Closed");
    await runtime.invoke("work", { command: "close", id: closed, by: "smoke" });
    untouched.push(closed);
    const blocker = await create("Blocker", {});
    const waiting = await create("Waiting", optedIn, { prerequisites: [blocker] });
    untouched.push(waiting);
    const reference = runtime.graph.observeReference(
      {
        lakeId: "00000000-0000-4000-8000-000000000001",
        workspace: "/source",
        nodeId: "source-task",
      },
      { title: "Source task", state: "active", revision: 1, kind: "work/task" },
    );
    untouched.push(reference.id);
    const failures = [
      await create("Missing seat", { [attrs.autoRun]: true }),
      await create("Invalid seat", { ...optedIn, [attrs.seat]: 42 }),
      await create("Invalid directory", { ...optedIn, [attrs.cwd]: "relative" }),
    ];
    const unavailable = [
      await create("Unknown seat", { ...optedIn, [attrs.seat]: "missing" }),
      await create("Unavailable seat", { ...optedIn, [attrs.seat]: "unavailable" }),
    ];
    const occupied = await create("Existing writer");
    assert.ok(agentsBinding !== undefined);
    const existing = agentsBinding.instance(runtime.context).start({
      seat: "worker",
      cwd: dir,
      target: occupied,
      prompt: "Manual writer",
    });
    const customDir = join(dir, "custom");
    await mkdir(customDir);
    const custom = await create("Custom cwd", { ...optedIn, [attrs.cwd]: customDir });
    await poll();
    for (const task of untouched) assert.equal(runs(task).length, 0, task);
    for (const task of failures)
      assert.equal(typeof runtime.graph.show(task).attributes[attrs.error], "string");
    for (const task of [...unavailable, occupied])
      assert.equal(runtime.graph.show(task).attributes[attrs.error], undefined);
    for (const task of unavailable) assert.equal(runs(task).length, 0);
    assert.deepEqual(
      runs(occupied).map(({ id }) => id),
      [existing.id],
    );
    assert.equal(runs(custom)[0]?.attributes[agentAttributes.cwd], realpathSync(customDir));
    const failedRevisions = failures.map((task) => runtime?.graph.show(task).revision);
    assert.ok(agentsBinding !== undefined);
    const acceptedCount = agentsBinding.instance(runtime.context).runs().length;
    const launchCount = launches;
    await poll();
    await poll();
    assert.equal(agentsBinding.instance(runtime.context).runs().length, acceptedCount);
    assert.equal(launches, launchCount);
    assert.deepEqual(
      failures.map((task) => runtime?.graph.show(task).revision),
      failedRevisions,
      "Rejected input must not produce noisy polling writes",
    );

    // A manual writer blocks admission only until its custody settles.
    const manual = runtime.graph.show(existing.id);
    const manualFact = facts.get(z.string().parse(manual.attributes[agentAttributes.handle]));
    assert.ok(manualFact !== undefined);
    facts.set(manualFact.handle, {
      ...manualFact,
      phase: "terminal",
      exit: { code: 1, signal: null },
    });
    await runtime.invoke("agent", { command: "reconcile" });
    await poll();
    assert.equal(runs(occupied).length, 2);
    assert.equal(runtime.graph.show(occupied).attributes[attrs.error], undefined);

    // Clearing a rejected admission permits its first acceptance, not retries after settlement.
    const repaired = failures[0];
    assert.ok(repaired !== undefined);
    runtime.graph.update(repaired, { attributes: { [attrs.seat]: "worker", [attrs.error]: null } });
    await runtime.invoke("work", { command: "close", id: blocker, by: "smoke" });
    await poll();
    assert.equal(runs(repaired).length, 1);
    assert.equal(runs(waiting).length, 1);

    await runtime.invoke("flag", { command: "set", name: agentFlags.codex.name, value: false });
    const disabled = await create("Disabled provider must not fall back");
    await poll();
    assert.equal(runs(disabled).length, 0);
    assert.equal(runtime.graph.show(disabled).attributes[attrs.error], undefined);
    await runtime.invoke("flag", { command: "set", name: agentFlags.codex.name, value: true });
    await poll();
    assert.equal(runs(disabled).length, 1, "A newly available seat permits first admission");

    // The worker claims its exact task; Work Agents releases only that assignment on settlement.
    const invocation = z
      .string()
      .parse(runtime.graph.show(run.id).attributes[agentAttributes.invocation]);
    const native = z.object({ identity: z.string() }).parse(
      await runtime.invoke("agent", {
        command: "native",
        provider: "codex",
        nativeSessionId: `smoke-${admitted}`,
        cwd: dir,
        event: "agent-start",
        runId: run.id,
        invocation,
      }),
    );
    await runtime.invoke(
      "work",
      { command: "claim", id: admitted, assignee: native.identity, by: native.identity },
      { env: { BL_RUN_REFERENCE: `${run.id}:${invocation}` } },
    );
    const fact = facts.get(
      z.string().parse(runtime.graph.show(run.id).attributes[agentAttributes.handle]),
    );
    assert.ok(fact !== undefined);
    facts.set(fact.handle, { ...fact, phase: "terminal", exit: { code: 1, signal: null } });
    await runtime.invoke("agent", { command: "reconcile" });
    await runtime.drain();
    assert.ok(workBinding !== undefined);
    const task = workBinding.instance(runtime.context).get(admitted);
    assert.ok(task.kind === "task");
    assert.equal(task.assignment, null);
    assert.equal(task.state, "open", "Process settlement is not task completion");
    await assert.rejects(
      runtime.invoke("agent", { command: "retry", id: run.id }),
      /request binding/u,
    );
    // Graph blockers and intentional opt-out prevent both scanner and Mail recovery.
    const recoveryBlocker = await create("Recovery blocker", {});
    await runtime.invoke("work", {
      command: "link",
      from: admitted,
      to: recoveryBlocker,
      relation: "depends-on",
    });
    await poll();
    assert.equal(runs(admitted).length, 1);
    const blockedMail = await runtime.invoke(
      "mail",
      {
        command: "send",
        to: native.identity,
        subject: "blocked",
        body: "Do not resume blocked work",
      },
      { identity: "smoke" },
    );
    assert.equal(z.object({ status: z.string() }).parse(blockedMail).status, "undeliverable");
    await runtime.invoke("work", { command: "close", id: recoveryBlocker, by: "smoke" });
    runtime.graph.update(admitted, { attributes: { [attrs.autoRun]: false } });
    await poll();
    assert.equal(runs(admitted).length, 1);
    assert.equal(
      z.object({ status: z.string() }).parse(
        await runtime.invoke(
          "mail",
          {
            command: "send",
            to: native.identity,
            subject: "paused",
            body: "Do not resume paused work",
          },
          { identity: "smoke" },
        ),
      ).status,
      "undeliverable",
    );
    runtime.graph.update(admitted, { attributes: { [attrs.autoRun]: true } });
    // Mail wins the first continuation; scanner must follow it, not fork the parent.
    await runtime.invoke(
      "mail",
      { command: "send", to: native.identity, subject: "continue", body: "Resume now" },
      { identity: "smoke" },
    );
    await poll();
    assert.equal(runs(admitted).length, 2);
    const mailChild = runs(admitted).find((entry) => entry.id !== run.id);
    assert.ok(mailChild !== undefined);
    assert.equal(mailChild.attributes[agentAttributes.requestId], `mail-agents/${run.id}`);
    assert.equal(mailChild.attributes[agentAttributes.identity], native.identity);
    await runtime.invoke("work", { command: "close", id: admitted, by: "smoke" });
    await runtime.invoke("work", {
      command: "reopen",
      id: admitted,
      reason: "recovery",
      by: "smoke",
    });
    runtime.graph.update(admitted, { attributes: { [attrs.cwd]: customDir } });
    await runtime.stop();
    runtime = await open();
    await poll();
    assert.equal(runs(admitted).length, 2, "Restart/reopening must retain continuation history");
    await assert.rejects(
      runtime.invoke("agent", { command: "resume", id: run.id, prompt: "Stale parent" }),
      /accepted continuation/u,
    );
    async function settle(id: string) {
      assert.ok(runtime !== undefined);
      const current = runtime.graph.show(id);
      const currentFact = facts.get(z.string().parse(current.attributes[agentAttributes.handle]));
      assert.ok(currentFact !== undefined);
      facts.set(currentFact.handle, {
        ...currentFact,
        phase: "terminal",
        exit: { code: 0, signal: null },
      });
      await runtime.invoke("agent", { command: "reconcile" });
      await runtime.drain();
    }
    // The resumed identity must claim again, binding the current invocation rather than its released parent.
    const childInvocation = z
      .string()
      .parse(runtime.graph.show(mailChild.id).attributes[agentAttributes.invocation]);
    await runtime.invoke("agent", {
      command: "native",
      provider: "codex",
      nativeSessionId: `smoke-${admitted}`,
      cwd: dir,
      event: "agent-start",
      runId: mailChild.id,
      invocation: childInvocation,
    });
    await runtime.invoke(
      "work",
      { command: "claim", id: admitted, assignee: native.identity, by: native.identity },
      { env: { BL_RUN_REFERENCE: `${mailChild.id}:${childInvocation}` } },
    );
    // Two more automatic continuations use the same native identity and original owning worktree.
    let tip = mailChild.id;
    for (let count = 3; count <= 4; count++) {
      await settle(tip);
      await poll();
      assert.equal(runs(admitted).length, count);
      const parentId = tip;
      const graph: Runtime["graph"] = runtime.graph;
      const child = runs(admitted).find(
        (entry) => graph.edge(entry.id, parentId, agentRelations.continues) !== null,
      );
      assert.ok(child !== undefined);
      assert.equal(child.attributes[agentAttributes.cwd], realpathSync(dir));
      assert.equal(child.attributes[agentAttributes.identity], native.identity);
      tip = child.id;
    }
    await settle(tip);
    // Mail cannot take a fourth automatic continuation, even before the scanner records exhaustion.
    assert.equal(
      z
        .object({ status: z.string() })
        .parse(
          await runtime.invoke(
            "mail",
            { command: "send", to: native.identity, subject: "over budget", body: "Do not resume" },
            { identity: "smoke" },
          ),
        ).status,
      "undeliverable",
    );
    await poll();
    assert.equal(runs(admitted).length, 5, "Initial + three worker continuations + ONE Oracle");
    assert.equal(typeof runtime.graph.show(admitted).attributes[attrs.exhausted], "string");
    const oracle = runs(admitted).find(
      (entry) => entry.attributes[agentAttributes.seat] === "oracle",
    );
    assert.ok(oracle !== undefined);
    await settle(oracle.id);
    await poll();
    await runtime.stop();
    runtime = await open();
    await poll();
    assert.equal(
      runs(admitted).length,
      5,
      "Oracle settlement and restarts cannot replenish the budget",
    );
    assert.equal(workBinding?.instance(runtime.context).get(admitted).state, "open");
    const oracleIdentity = z
      .string()
      .parse(runtime.graph.show(oracle.id).attributes[agentAttributes.identity]);
    assert.equal(
      z.object({ status: z.string() }).parse(
        await runtime.invoke(
          "mail",
          {
            command: "send",
            to: oracleIdentity,
            subject: "Oracle must stop",
            body: "No self retry",
          },
          { identity: "smoke" },
        ),
      ).status,
      "undeliverable",
    );
    // Exhaustion preserves explicit manual recovery and prior history.
    const resumed = identifier.parse(
      await runtime.invoke("agent", { command: "resume", id: tip, prompt: "Explicit recovery" }),
    );
    assert.notEqual(resumed.id, tip);
    await poll();
    assert.equal(runs(admitted).length, 6);

    for (const failure of ["preparation", "launch"]) {
      preparationFails = failure === "preparation";
      launchFails = failure === "launch";
      const failedTask = await create(`Worker ${failure} failure`);
      await poll();
      const failed = runs(failedTask)[0];
      assert.ok(failed !== undefined);
      assert.equal(failed.attributes[agentAttributes.settled], true);
      assert.equal(failed.attributes[agentAttributes.state], "failed");
      const before: number = launches;
      preparationFails = false;
      launchFails = false;
      await poll();
      assert.equal(runs(failedTask).length, 2);
      assert.equal(
        launches,
        before + 1,
        "Pre-session failure gets a fresh continuation in the same budget",
      );
      const child = runs(failedTask).find((entry) => entry.id !== failed.id);
      assert.ok(child !== undefined);
      assert.notEqual(runtime.graph.edge(child.id, failed.id, agentRelations.continues), null);
      assert.equal(child.attributes[agentAttributes.resumes], false);
      assert.equal(child.attributes[agentAttributes.identity], undefined);
    }
    // Stopped-but-unsettled custody never permits recovery, regardless of elapsed time.
    const uncertainTask = await create("Uncertain custody");
    await poll();
    const uncertain = runs(uncertainTask)[0];
    assert.ok(uncertain !== undefined);
    const uncertainFact = facts.get(z.string().parse(uncertain.attributes[agentAttributes.handle]));
    assert.ok(uncertainFact !== undefined);
    facts.set(uncertainFact.handle, {
      ...uncertainFact,
      phase: "terminal",
      cancellation: { reason: "cancel", stop: "uncertain" },
    });
    await runtime.invoke("agent", { command: "reconcile" });
    await poll();
    await poll();
    assert.equal(runs(uncertainTask).length, 1);
    assert.equal(runtime.graph.show(uncertain.id).attributes[agentAttributes.settled], false);
    // A confirmed explicit cancellation remains a pause, not a failed-worker retry.
    facts.set(uncertainFact.handle, {
      ...uncertainFact,
      phase: "terminal",
      exit: { code: 1, signal: null },
      cancellation: { reason: "cancel", stop: "observed" },
    });
    await runtime.invoke("agent", { command: "reconcile" });
    await poll();
    assert.equal(runs(uncertainTask).length, 1);
    assert.equal(
      runtime.graph.show(uncertain.id).attributes[agentAttributes.lifecycle],
      "cancelled",
    );
    const abandonedTask = await create("Pending cancellation");
    assert.ok(agentsBinding !== undefined);
    const abandoned = agentsBinding.instance(runtime.context).start({
      target: abandonedTask,
      requestId: `work-auto-bot/${abandonedTask}`,
      seat: "worker",
      cwd: dir,
      prompt: "Pending work",
    });
    await agentsBinding.instance(runtime.context).cancel(abandoned.id);
    await poll();
    assert.equal(runs(abandonedTask).length, 1);

    // Another current assignee and disabled seats protect settled tasks from all automatic admission.
    const reservedTask = await create("Different assignee after settlement");
    await poll();
    const reserved = runs(reservedTask)[0];
    assert.ok(reserved !== undefined);
    await settle(reserved.id);
    const reservation = z.object({ assignment: identifier }).parse(
      await runtime.invoke("work", {
        command: "claim",
        id: reservedTask,
        assignee: "other",
        by: "smoke",
      }),
    );
    await poll();
    assert.equal(runs(reservedTask).length, 1);
    await runtime.invoke("work", {
      command: "release",
      id: reservedTask,
      assignmentId: reservation.assignment.id,
      reason: "done",
      by: "other",
    });
    await runtime.invoke("flag", { command: "set", name: agentFlags.codex.name, value: false });
    await poll();
    assert.equal(runs(reservedTask).length, 1);
    await runtime.invoke("flag", { command: "set", name: agentFlags.codex.name, value: true });
    await poll();
    assert.equal(runs(reservedTask).length, 2);

    // An idle external writer still owns a session until its explicit end observation.
    const externalTask = await create("External session owns the native writer");
    await poll();
    const externalParent = runs(externalTask)[0];
    assert.ok(externalParent !== undefined);
    await settle(externalParent.id);
    await runtime.invoke("agent", {
      command: "native",
      provider: "codex",
      nativeSessionId: `smoke-${externalTask}`,
      cwd: dir,
      event: "agent-start",
    });
    await poll();
    assert.equal(runs(externalTask).length, 1);
    await runtime.invoke("agent", {
      command: "native",
      provider: "codex",
      nativeSessionId: `smoke-${externalTask}`,
      cwd: dir,
      event: "session-end",
    });
    await poll();
    assert.equal(runs(externalTask).length, 2);

    // A missing owning worktree is a visible admission failure, never a fresh launch elsewhere.
    const lostDir = join(dir, "removed-worktree");
    await mkdir(lostDir);
    const lostTask = await create("Removed worktree", { ...optedIn, [attrs.cwd]: lostDir });
    await poll();
    const lost = runs(lostTask)[0];
    assert.ok(lost !== undefined);
    await settle(lost.id);
    await rm(lostDir, { recursive: true });
    await poll();
    assert.equal(runs(lostTask).length, 1);
    assert.equal(typeof runtime.graph.show(lostTask).attributes[attrs.error], "string");

    // Execution without session evidence is not a pre-session failure. Escalate once, never fresh-retry it.
    for (const oracleAvailable of [true, false]) {
      const noSessionTask = await create(`Missing session, Oracle available=${oracleAvailable}`);
      await poll();
      const noSession = runs(noSessionTask)[0];
      assert.ok(noSession !== undefined);
      missingSession = true;
      await settle(noSession.id);
      missingSession = false;
      const service = agentsBinding.instance(runtime.context);
      assert.throws(
        () =>
          service.recoverLaunch(noSession.id, "Unsafe fresh recovery", `unsafe/${noSession.id}`),
        /Launch recovery requires/u,
      );
      if (!oracleAvailable)
        await runtime.invoke("flag", { command: "set", name: agentFlags.codex.name, value: false });
      preparationFails = true;
      await poll();
      preparationFails = false;
      assert.equal(typeof runtime.graph.show(noSessionTask).attributes[attrs.exhausted], "string");
      assert.equal(runs(noSessionTask).length, oracleAvailable ? 2 : 1);
      if (!oracleAvailable) {
        assert.equal(typeof runtime.graph.show(noSessionTask).attributes[attrs.error], "string");
        await runtime.invoke("flag", { command: "set", name: agentFlags.codex.name, value: true });
      }
      await poll();
      assert.equal(
        runs(noSessionTask).length,
        oracleAvailable ? 2 : 1,
        "Oracle failure/unavailability is terminal and visible, not a self retry loop",
      );
    }
    assert.deepEqual(runtime.errors, []);
    await runtime.stop();
    runtime = await open(false);
    assert.equal(
      runtime.scheduler.pending().some((entry) => entry.key === "work-auto-bot/scan"),
      false,
      "Removing the extension after shutdown must leave no unknown persisted handler",
    );
    assert.deepEqual(runtime.errors, []);
  } finally {
    if (runtime !== undefined) await runtime.stop();
    await rm(dir, { recursive: true, force: true });
  }
}

async function packagedPhase(): Promise<void> {
  const host = await system();
  try {
    const workspace = await host.workspace("work-auto-bot-smoke", [
      "@botlake/extension-batteries",
      "@botlake/extension-identity",
      "./flags.ts",
      "./agents.ts",
      "./work.ts",
      "./work-auto-bot.ts",
    ]);
    await Bun.write(
      join(workspace, "flags.ts"),
      `import { agentFlags } from "@botlake/extension-agents";
import { configureFlags } from "@botlake/extension-flags";
export default configureFlags([[agentFlags.codex, true]]);\n`,
    );
    await Bun.write(
      join(workspace, "agents.ts"),
      `import { agents, builtinProviders, agentFlags } from "@botlake/extension-agents";
const codex = builtinProviders.codex({flag:agentFlags.codex});
export default agents({ providers: [{ ...codex, prepare() { throw new Error("packaged preparation fixture"); } }], aliases: { worker: { parent: "codex", model: "packaged-fixture" }, oracle: { parent: "worker" } } });\n`,
    );
    await Bun.write(
      join(workspace, "work.ts"),
      `import { work } from "@botlake/extension-work";
export default work();\n`,
    );
    await Bun.write(
      join(workspace, "work-auto-bot.ts"),
      `import { workAutoBot } from "@botlake/extension-work-auto-bot";
import agents from "./agents.ts";
import work from "./work.ts";
export default workAutoBot({ agents, work });\n`,
    );
    await host.botlake(["lake", "start", "--workspace", workspace]);
    const task = identifier.parse(
      await host.bl(workspace, "work", {
        command: "create",
        title: "Packed admission",
        by: "smoke",
      }),
    ).id;
    await host.bl(workspace, "node", { command: "update", id: task, attributes: optedIn });
    const result = z.object({ reason: z.literal("satisfied") }).parse(
      await host.bl(workspace, "await", {
        query: "work-auto-bot-exhausted",
        minCount: 1,
        timeoutSecs: 15,
      }),
    );
    assert.equal(result.reason, "satisfied");
    const listed = z
      .object({ runs: z.array(identifier), total: z.literal(5) })
      .parse(await host.bl(workspace, "agent", { command: "list" }));
    const records = await Promise.all(
      listed.runs.map(async ({ id }) =>
        z
          .object({ id: z.string(), attributes: z.record(z.string(), z.json()) })
          .parse(await host.bl(workspace, "agent", { command: "show", id })),
      ),
    );
    const accepted = records.find(
      (run) => run.attributes[agentAttributes.requestId] === `work-auto-bot/${task}`,
    );
    assert.ok(accepted !== undefined);
    assert.equal(accepted.attributes[agentAttributes.cwd], realpathSync(workspace));
    const oracle = records.find(
      (run) => run.attributes[agentAttributes.requestId] === `work-auto-bot/${task}/oracle`,
    );
    assert.ok(oracle !== undefined);
    assert.equal(
      z.object({ reason: z.string() }).parse(
        await host.bl(workspace, "await", {
          query: "agent-run-settled",
          params: { runId: oracle.id },
          minCount: 1,
          timeoutSecs: 10,
        }),
      ).reason,
      "satisfied",
    );
    const original = z
      .object({ item: z.object({ state: z.string(), notes: z.string() }) })
      .parse(await host.bl(workspace, "work", { command: "show", id: task }));
    assert.equal(original.item.state, "open");
    assert.ok(original.item.notes.includes("exhausted"));
    assert.ok(original.item.notes.includes(oracle.id));
    await host.botlake(["lake", "restart", "--workspace", workspace]);
    await host.bl(workspace, "work", { command: "close", id: task, by: "smoke" });
    await host.bl(workspace, "work", {
      command: "reopen",
      id: task,
      reason: "manual recovery",
      by: "smoke",
    });
    assert.equal(
      z.object({ total: z.number() }).parse(await host.bl(workspace, "agent", { command: "list" }))
        .total,
      5,
    );
    assert.ok(
      String(
        await host.bl(workspace, "agent", { command: "retry", id: accepted.id }, false),
      ).includes("request binding"),
    );
    const info = z
      .object({
        extensions: z.array(z.object({ name: z.string(), readme: z.string().nullable() })),
      })
      .parse(await host.botlake(["lake", "info", "--workspace", workspace]));
    assert.ok(
      info.extensions
        .find((extension) => extension.name === "work-auto-bot")
        ?.readme?.endsWith("/README.md") === true,
    );
  } finally {
    await host.close();
  }
}

await directPhase();
await packagedPhase();
console.log(
  "work-auto-bot smoke verified: exact typed bindings and derived requirements; eligibility; atomic admission; visible latched rejection; writer protection; cwd; restart/reopen deduplication; exact assignment settlement; Mail arbitration; readiness/pause; bounded recovery and Oracle; explicit manual resume; pre-session launch recovery; packed selection",
);
