// Drive Work gate transitions, probe evaluation and the packaged CLI against disposable SQLite lakes.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ManualClock, Runtime, q } from "@botlake/core";
import { identity } from "@botlake/extension-identity";
import {
  defineProbe,
  work,
  workAttributes,
  workStore,
  type GateCommand,
  type GateStatus,
} from "@botlake/extension-work";
import { z } from "zod";

import { system } from "../tests/blackbox/fixtures/system.ts";
import { copyWorkflowExample } from "../tests/blackbox/fixtures/workflows.ts";

const dir = await mkdtemp(join(tmpdir(), "botlake-work-gates-"));
const runtime = new Runtime({ database: join(dir, "lake.sqlite"), clock: new ManualClock() });
const at = "2026-11-04T20:00:00.000Z";
const policy = { everyMs: 60_000, maxAttempts: 2, timeoutMs: 5_000 };

try {
  await runtime.start([identity(), work()]);
  const store = workStore(runtime.context);
  const make = (title: string) =>
    store.gates.create({ title, probe: "smoke", params: {}, policy, by: "smoke" });
  const apply = (id: string, command: GateCommand, expected: GateStatus["status"]) => {
    const result = store.gates.apply(id, command);
    assert.equal(result.kind, "moved");
    assert.equal(store.gates.get(id).status.status, expected);
  };
  const attempt = (
    round: number,
    number: number,
    outcome: "passed" | "failed" | "errored",
  ): GateCommand => ({
    type: "attempt",
    round,
    attempt: number,
    at,
    by: "probe",
    result:
      outcome === "passed"
        ? { outcome, message: "reachable" }
        : { outcome, at, message: outcome === "failed" ? "not yet" : "probe threw" },
  });
  const refuseUnchanged = (id: string, command: GateCommand, code: "stale" | "closed") => {
    const before = store.gates.get(id);
    assert.deepEqual(store.gates.apply(id, command), {
      kind: "refused",
      code,
      message:
        code === "closed"
          ? "Gate is already closed"
          : `Expected round ${before.status.status === "cleared" || before.status.status === "dismissed" ? "none" : before.status.round} attempt none`,
    });
    assert.deepEqual(store.gates.get(id), before);
  };

  const passed = make("pending pass");
  apply(passed.id, attempt(1, 1, "passed"), "cleared");
  refuseUnchanged(passed.id, { type: "retry", at, by: "smoke", reason: "late" }, "closed");

  const waitingPass = make("waiting pass");
  apply(waitingPass.id, attempt(1, 1, "failed"), "waiting");
  apply(waitingPass.id, attempt(1, 2, "passed"), "cleared");

  const waitingRetry = make("waiting retry");
  apply(waitingRetry.id, attempt(1, 1, "failed"), "waiting");
  apply(waitingRetry.id, { type: "retry", at, by: "smoke", reason: "again" }, "pending");

  const retrying = make("fail then error");
  apply(retrying.id, attempt(1, 1, "failed"), "waiting");
  apply(retrying.id, attempt(1, 2, "errored"), "exhausted");
  refuseUnchanged(retrying.id, attempt(1, 3, "failed"), "stale");
  apply(retrying.id, { type: "retry", at, by: "smoke", reason: "fixed" }, "pending");

  const stale = make("stale attempts");
  const before = store.gates.get(stale.id);
  const staleResult = store.gates.apply(stale.id, attempt(2, 1, "passed"));
  assert.equal(staleResult.kind, "refused");
  assert.equal(staleResult.code, "stale");
  assert.deepEqual(store.gates.get(stale.id), before);
  apply(stale.id, attempt(1, 1, "failed"), "waiting");
  const waitingBefore = store.gates.get(stale.id);
  assert.equal(store.gates.apply(stale.id, attempt(1, 1, "passed")).kind, "refused");
  assert.deepEqual(store.gates.get(stale.id), waitingBefore);

  const cleared = make("manual clear");
  apply(cleared.id, { type: "clear", at, by: "actor", message: "verified" }, "cleared");
  const dismissed = make("dismiss");
  apply(dismissed.id, { type: "dismiss", at, by: "actor", reason: "not required" }, "dismissed");

  const blocker = make("queue blocker");
  const task = store.create({
    kind: "task",
    title: "dependent",
    prerequisites: [blocker.id],
    by: "smoke",
  });
  assert.equal(store.inspect(task.id).ready, false);
  assert.equal(
    store.list({ view: "available" }).items.some(({ id }) => id === task.id),
    false,
  );
  assert.equal(runtime.graph.all({ where: q.eq("id", task.id), ready: true }).length, 0);
  apply(blocker.id, { type: "dismiss", at, by: "actor", reason: "waived" }, "dismissed");
  assert.equal(store.inspect(task.id).ready, true);
  assert.equal(
    store.list({ view: "available" }).items.some(({ id }) => id === task.id),
    true,
  );
  assert.equal(runtime.graph.all({ where: q.eq("id", task.id), ready: true }).length, 1);
  assert.equal(
    store.list({ view: "available" }).items.some(({ id }) => id === blocker.id),
    false,
  );
  assert.equal(
    runtime.graph.show(blocker.id).attributes[workAttributes.status] !== undefined,
    true,
  );

  await evaluateProbes(join(dir, "evaluated.sqlite"));
  await packagedProbes();
  console.log(
    JSON.stringify({
      ok: true,
      transitions: "all",
      refusalsPreserved: true,
      evaluator: true,
      packaged: true,
    }),
  );
} finally {
  await runtime.stop();
  await rm(dir, { recursive: true, force: true });
}

async function evaluateProbes(database: string): Promise<void> {
  const clock = new ManualClock();
  let ready = false;
  let attempts = 0;
  const probe = defineProbe({
    name: "ready",
    description: "Wait for the smoke condition",
    params: z.object({ label: z.string().min(1) }),
    policy: { everyMs: 1_000, maxAttempts: 2, timeoutMs: 1_000 },
    async run({ label }) {
      attempts += 1;
      return { outcome: ready ? "passed" : "failed", message: label };
    },
  });
  let evaluated = new Runtime({ database, clock });
  try {
    await evaluated.start([identity(), work({ probes: [probe] })]);
    const store = workStore(evaluated.context);
    const task = store.create({ kind: "task", title: "Probe dependent" });
    const gate = z.object({ id: z.string() }).parse(
      await evaluated.invoke(
        "gate",
        {
          command: "create",
          title: "Check readiness",
          probe: "ready",
          param: ['label="Condition holds"'],
          dependent: [task.id],
        },
        { identity: "smoke" },
      ),
    );
    assert.equal(store.inspect(task.id).ready, false);
    clock.advance(clock.now());
    await evaluated.drain();
    assert.equal(store.gates.get(gate.id).status.status, "waiting");
    assert.equal(attempts, 1);

    // Restore a missing durable wake as well as the gate state after restart.
    for (const wake of evaluated.scheduler.pending()) evaluated.scheduler.cancel(wake.key);
    await evaluated.stop();
    evaluated = new Runtime({ database, clock });
    await evaluated.start([identity(), work({ probes: [probe] })]);
    assert.equal(evaluated.scheduler.pending().length, 1);
    ready = true;
    clock.advance(1_000);
    await evaluated.drain();
    const restored = workStore(evaluated.context);
    assert.equal(restored.gates.get(gate.id).status.status, "cleared");
    assert.equal(restored.inspect(task.id).ready, true);
    assert.equal(attempts, 2);
    assert.equal(evaluated.scheduler.pending().length, 0);
    assert.deepEqual(evaluated.errors, []);
  } finally {
    await evaluated.stop();
  }
}

async function packagedProbes(): Promise<void> {
  const host = await system();
  try {
    const workspace = await host.workspace("work-probes", [
      "@botlake/extension-batteries",
      "@botlake/extension-identity",
      "@botlake/extension-workflow",
      "./work.ts",
    ]);
    await Bun.write(
      join(workspace, "work.ts"),
      `
import { defineProbe, work } from "@botlake/extension-work";
import { z } from "zod";
export default work({ probes: [defineProbe({
  name: "ready", description: "Packaged probe", params: z.object({ label: z.string().min(1) }),
  policy: { everyMs: 1000, maxAttempts: 1, timeoutMs: 1000 },
  async run({ label }) { return { outcome: "passed", message: label }; },
})] });
`,
    );
    await copyWorkflowExample(workspace, "gate-escalation");
    await host.botlake(["lake", "start", "--workspace", workspace]);
    const cli = (args: string[]) => host.cli(["--workspace", workspace, ...args]);
    assert.deepEqual(
      z
        .object({ items: z.array(z.object({ name: z.string() })) })
        .parse(await cli(["gate", "probes"]))
        .items.map(({ name }) => name),
      ["ready"],
    );
    const gate = z
      .object({ id: z.string() })
      .parse(
        await cli([
          "gate",
          "create",
          "Packaged readiness",
          "--probe",
          "ready",
          "--param",
          "label=ready",
        ]),
      );
    const waited = z
      .object({ reason: z.string() })
      .parse(
        await cli([
          "await",
          "--query",
          "node-closed",
          "--params",
          JSON.stringify({ id: gate.id }),
          "--min-count",
          "1",
          "--timeout-secs",
          "10",
        ]),
      );
    assert.equal(waited.reason, "satisfied");
    const shown = z
      .object({ item: z.object({ status: z.object({ status: z.string() }) }) })
      .parse(await cli(["work", "show", gate.id]));
    assert.equal(shown.item.status.status, "cleared");

    // Workflow-owned probes resolve through Work regardless of selection order.
    const flag = join(workspace, "ready.flag");
    await Bun.write(flag, "ready");
    const gated = z
      .object({
        run: z.object({ id: z.string() }),
        gates: z.array(z.object({ id: z.string() })),
      })
      .parse(
        await cli(["workflow", "start", "gate-escalation", "--input", JSON.stringify({ flag })]),
      );
    const workflowGate = gated.gates[0];
    assert.ok(workflowGate !== undefined);
    const workflowWaited = z
      .object({ reason: z.string() })
      .parse(
        await cli([
          "await",
          "--query",
          "node-closed",
          "--params",
          JSON.stringify({ id: workflowGate.id }),
          "--min-count",
          "1",
          "--timeout-secs",
          "10",
        ]),
      );
    assert.equal(workflowWaited.reason, "satisfied");
    const workflowView = z.object({
      run: z.object({ status: z.string() }),
      tasks: z.array(z.object({ id: z.string(), title: z.string() })),
    });
    const afterGate = workflowView.parse(await cli(["workflow", "show", gated.run.id]));
    const outcome = afterGate.tasks.find(({ title }) => title === "Record outcome");
    assert.ok(outcome !== undefined);
    const completedGate = workflowView.parse(
      await cli(["workflow", "complete", outcome.id, "done"]),
    );
    assert.equal(completedGate.run.status, "complete");
  } finally {
    await host.close();
  }
}
