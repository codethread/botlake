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
          finish: () => ({
            success: false,
            result: null,
            error: "fixture failure",
            sessionId: "smoke-native",
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
      },
    });
    workBinding = work();
    const autoBot = workAutoBot({ agents: agentsBinding, work: workBinding });
    assert.deepEqual(autoBot.requires, [workBinding.name, agentsBinding.name]);
    await next.start([
      configureFlags([[agentFlags.codex, true]]),
      identity(),
      agentsBinding,
      workBinding,
      workAgents({ checkIntervalMs: 1000 }),
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
        nativeSessionId: "smoke-native",
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
    await poll();
    assert.equal(runs(admitted).length, 1);
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
    assert.equal(runs(admitted).length, 1, "Restart/reopening must retain once-per-task history");
    const resumed = identifier.parse(
      await runtime.invoke("agent", { command: "resume", id: run.id, prompt: "Explicit recovery" }),
    );
    assert.notEqual(resumed.id, run.id);
    await poll();
    assert.equal(runs(admitted).length, 2, "Only explicit continuation may launch again");

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
      assert.equal(runs(failedTask).length, 1);
      assert.equal(launches, before, "Settlement must not start an automatic worker retry loop");
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
export default agents({ providers: [{ ...codex, prepare() { throw new Error("packaged preparation fixture"); } }], aliases: { worker: { parent: "codex", model: "packaged-fixture" } } });\n`,
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
        query: "agent-run-failed",
        minCount: 1,
        timeoutSecs: 10,
      }),
    );
    assert.equal(result.reason, "satisfied");
    const listed = z
      .object({ runs: z.array(identifier), total: z.literal(1) })
      .parse(await host.bl(workspace, "agent", { command: "list" }));
    const accepted = z
      .object({ attributes: z.record(z.string(), z.json()) })
      .parse(await host.bl(workspace, "agent", { command: "show", id: listed.runs[0]?.id }));
    assert.equal(accepted.attributes[agentAttributes.requestId], `work-auto-bot/${task}`);
    assert.equal(accepted.attributes[agentAttributes.cwd], realpathSync(workspace));
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
  "work-auto-bot smoke verified: exact typed bindings and derived requirements; eligibility; atomic admission; visible latched rejection; writer protection; cwd; restart/reopen deduplication; exact assignment settlement; explicit resume; no worker retries; packed selection",
);
