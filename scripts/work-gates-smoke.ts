// Drive every Work gate transition against a disposable SQLite lake.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Runtime, q } from "@botlake/core";
import { identity } from "@botlake/extension-identity";
import {
  work,
  workAttributes,
  workStore,
  type GateCommand,
  type GateStatus,
} from "@botlake/extension-work";

const dir = await mkdtemp(join(tmpdir(), "botlake-work-gates-"));
const runtime = new Runtime({ database: join(dir, "lake.sqlite") });
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

  console.log(JSON.stringify({ ok: true, transitions: "all", refusalsPreserved: true }));
} finally {
  await runtime.stop();
  await rm(dir, { recursive: true, force: true });
}
