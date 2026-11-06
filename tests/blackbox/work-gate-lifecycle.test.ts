import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ManualClock, Runtime } from "@botlake/core";
import { identity } from "@botlake/extension-identity";
import {
  defineProbe,
  gateProbes,
  gateService,
  work,
  workGateChanged,
  workStore,
  type ProbeVerdict,
} from "@botlake/extension-work";
import { z } from "zod";

for (const command of ["clear", "dismiss", "retry", "shutdown"] as const) {
  test(`native gate ${command} aborts and drains before any replacement or write`, async () => {
    await fixture(async ({ runtime, clock, visits, writes, active, gate }) => {
      clock.advance(0);
      await visits[0].started.promise;
      expect(active()).toBe(1);

      let drained = false;
      let draining: Promise<void>;
      if (command === "shutdown") {
        draining = runtime.stop();
      } else {
        await runtime.invoke(
          "gate",
          command === "retry"
            ? { command, id: gate, reason: "new authority" }
            : { command: "clear", id: gate, reason: "withdrawn", dismiss: command === "dismiss" },
          { identity: "operator" },
        );
        draining = runtime.drain();
      }
      void draining.then(() => {
        drained = true;
      });
      expect(visits[0].signal?.aborted).toBe(true);
      expect(drained).toBe(false);
      expect(writes).toEqual([]);

      if (command === "retry") {
        // Deliver the replacement wake while abort cleanup is still paused.
        clock.advance(0);
        expect(active()).toBe(1);
        expect(visits[1].signal).toBeUndefined();
      }
      visits[0].release.resolve();
      if (command === "retry") {
        await visits[1].started.promise;
        expect(visits[1].signal?.aborted).toBe(false);
        expect(active()).toBe(1);
        expect(writes).toEqual([]);
        visits[1].release.resolve();
        await draining;
        await runtime.drain();
        expect(writes).toEqual([1]);
        expect(workStore(runtime.context).gates.get(gate).status).toMatchObject({
          status: "cleared",
          via: "probe",
        });
      } else {
        await draining;
        expect(active()).toBe(0);
        expect(writes).toEqual([]);
        if (command === "shutdown") return;
        expect(workStore(runtime.context).gates.get(gate).status.status).toBe(
          command === "dismiss" ? "dismissed" : "cleared",
        );
      }
      expect(runtime.scheduler.pending()).toEqual([]);
      expect(runtime.errors).toEqual([]);
    });
  });
}

test("committed retry revokes immediately, but a rolled-back transition keeps the original authority", async () => {
  await fixture(async ({ runtime, clock, visits, writes, gate }) => {
    clock.advance(0);
    await visits[0].started.promise;
    const service = gateService(runtime.context);
    expect(() =>
      runtime.graph.atomic(() => {
        service.retry(gate, "operator", "rolled back");
        throw new Error("rollback");
      }),
    ).toThrow("rollback");
    expect(visits[0].signal?.aborted).toBe(false);
    expect(workStore(runtime.context).gates.get(gate).status).toEqual({
      status: "pending",
      round: 1,
    });
    expect(runtime.scheduler.pending()).toHaveLength(1);

    runtime.graph.atomic(() => {
      service.retry(gate, "operator", "committed");
      expect(visits[0].signal?.aborted).toBe(false);
    });
    expect(visits[0].signal?.aborted).toBe(true);
    // Deliver a duplicate generation as well as multiple replacement rounds.
    const wake = runtime.scheduler.pending()[0];
    if (wake === undefined) throw new Error("Expected replacement wake");
    runtime.scheduler.schedule(wake.key, clock.now(), wake.handler, wake.payload);
    clock.advance(0);
    // Supersede the still-waiting replacement before the old probe drains.
    service.retry(gate, "operator", "latest round only");
    clock.advance(0);
    expect(visits[1].signal).toBeUndefined();
    visits[0].release.resolve();
    await visits[1].started.promise;
    expect(workStore(runtime.context).gates.get(gate).status).toEqual({
      status: "pending",
      round: 3,
    });
    visits[1].release.resolve();
    await runtime.drain();
    expect(writes).toEqual([1]);
    expect(runtime.errors).toEqual([]);
  });
});

test("a late successful verdict cannot replace manual closure or publish after shutdown", async () => {
  for (const command of ["clear", "shutdown"] as const) {
    await fixture(async ({ runtime, clock, visits, gate, database }) => {
      const transitions: string[] = [];
      runtime.context.on(workGateChanged, ({ to }) => {
        transitions.push(to.status);
      });
      clock.advance(0);
      await visits[0].started.promise;
      if (command === "clear") {
        gateService(runtime.context).clear(gate, "operator", "manual verdict");
        visits[0].release.resolve();
        await runtime.drain();
        expect(workStore(runtime.context).gates.get(gate).status).toMatchObject({
          status: "cleared",
          via: "actor",
          message: "manual verdict",
        });
        expect(transitions).toEqual(["cleared"]);
      } else {
        const stopping = runtime.stop();
        expect(visits[0].signal?.aborted).toBe(true);
        visits[0].release.resolve();
        await stopping;
        expect(transitions).toEqual([]);
        const restored = new Runtime({ database, clock: new ManualClock() });
        try {
          await restored.start([identity(), work()]);
          expect(workStore(restored.context).gates.get(gate).status).toEqual({
            status: "pending",
            round: 1,
          });
          expect(restored.scheduler.pending()).toHaveLength(1);
        } finally {
          await restored.stop();
        }
      }
    }, false);
  }
});

test("probe timeout aborts, drains actual work, then preserves retry timing and exhaustion", async () => {
  await fixture(async ({ runtime, clock, visits, writes, active, gate }) => {
    clock.advance(0);
    await visits[0].started.promise;
    clock.advance(10);
    expect(visits[0].signal?.aborted).toBe(true);
    clock.advance(100);
    expect(active()).toBe(1);
    expect(visits[1].signal).toBeUndefined();
    expect(workStore(runtime.context).gates.get(gate).status).toEqual({
      status: "pending",
      round: 1,
    });
    visits[0].release.resolve();
    await runtime.drain();
    expect(writes).toEqual([]);
    expect(workStore(runtime.context).gates.get(gate).status).toMatchObject({
      status: "waiting",
      round: 1,
      attempts: 1,
      nextAt: new Date(100).toISOString(),
      last: { outcome: "errored", message: "Probe timed out after 10ms" },
    });
    expect(runtime.scheduler.pending()).toHaveLength(1);
    clock.advance(100);
    await visits[1].started.promise;
    clock.advance(110);
    expect(visits[1].signal?.aborted).toBe(true);
    visits[1].release.resolve();
    await runtime.drain();
    expect(workStore(runtime.context).gates.get(gate).status).toMatchObject({
      status: "exhausted",
      round: 1,
      attempts: 2,
      last: { outcome: "errored", message: "Probe timed out after 10ms" },
    });
    expect(runtime.scheduler.pending()).toEqual([]);
    expect(runtime.errors).toEqual([]);
  });
});

test("public store transitions revoke even while after-commit event delivery is blocked", async () => {
  await fixture(async ({ runtime, clock, visits, writes, gate }) => {
    const blocked = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    runtime.context.on(workGateChanged, async () => {
      entered.resolve();
      await blocked.promise;
    });
    try {
      clock.advance(0);
      await visits[0].started.promise;
      const gates = workStore(runtime.context).gates;
      gates.apply(gate, {
        type: "retry",
        at: new Date(0).toISOString(),
        by: "operator",
        reason: "replace",
      });
      // No event queue delivery or extra microtask is needed to revoke authority.
      expect(visits[0].signal?.aborted).toBe(true);
      await entered.promise;
      clock.advance(0);
      expect(visits[1].signal).toBeUndefined();
      visits[0].release.resolve();
      await visits[1].started.promise;
      expect(visits[1].signal?.aborted).toBe(false);
      gates.apply(gate, {
        type: "dismiss",
        at: new Date(0).toISOString(),
        by: "operator",
        reason: "withdraw",
      });
      expect(visits[1].signal?.aborted).toBe(true);
      visits[1].release.resolve();
    } finally {
      blocked.resolve();
    }
    await runtime.drain();
    expect(writes).toEqual([]);
    expect(workStore(runtime.context).gates.get(gate).status.status).toBe("dismissed");
    expect(runtime.scheduler.pending()).toEqual([]);
    expect(runtime.errors).toEqual([]);
  });
});

for (const command of ["clear", "shutdown"] as const) {
  test(`native ${command} while probe resolution is paused never starts revoked work`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "botlake-gate-resolver-"));
    const clock = new ManualClock();
    const runtime = new Runtime({ database: join(dir, "lake.sqlite"), clock });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let resolutions = 0;
    let runs = 0;
    const probe = defineProbe({
      name: "resolved",
      description: "Deferred resolution",
      params: z.object({}),
      policy: { everyMs: 100, maxAttempts: 1, timeoutMs: 10 },
      async run() {
        runs += 1;
        return { outcome: "passed", message: "unexpected run" };
      },
    });
    try {
      await runtime.start([
        identity(),
        work(),
        {
          name: "probe-provider",
          requires: ["work"],
          activate(ctx) {
            gateProbes(ctx).provide(async () => {
              if (++resolutions > 1) {
                entered.resolve();
                await release.promise;
              }
              return probe;
            });
          },
        },
      ]);
      const gate = await gateService(runtime.context).create({
        title: "Deferred probe",
        probe: "resolved",
        params: {},
        by: "operator",
      });
      clock.advance(0);
      await entered.promise;
      let drained = false;
      if (command === "clear") gateService(runtime.context).clear(gate.id, "operator", "withdraw");
      const draining = command === "shutdown" ? runtime.stop() : runtime.drain();
      void draining.then(() => {
        drained = true;
      });
      expect(drained).toBe(false);
      release.resolve();
      await draining;
      expect(runs).toBe(0);
      expect(runtime.errors).toEqual([]);
    } finally {
      release.resolve();
      await runtime.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });
}

interface Visit {
  started: ReturnType<typeof Promise.withResolvers<void>>;
  release: ReturnType<typeof Promise.withResolvers<void>>;
  signal?: AbortSignal;
}

interface Fixture {
  runtime: Runtime;
  clock: ManualClock;
  visits: [Visit, Visit];
  writes: number[];
  active: () => number;
  gate: string;
  database: string;
}

async function fixture(
  run: (fixture: Fixture) => Promise<void>,
  honorSignal = true,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "botlake-gate-lifecycle-"));
  const database = join(dir, "lake.sqlite");
  const clock = new ManualClock();
  const runtime = new Runtime({ database, clock });
  const visit = (): Visit => ({
    started: Promise.withResolvers<void>(),
    release: Promise.withResolvers<void>(),
  });
  const visits: [Visit, Visit] = [visit(), visit()];
  const writes: number[] = [];
  let calls = 0;
  let active = 0;
  const probe = defineProbe({
    name: "mutation",
    description: "Pause before a signal-authorized mutation",
    params: z.object({}),
    policy: { everyMs: 100, maxAttempts: 2, timeoutMs: 10 },
    async run(_params, { signal }): Promise<ProbeVerdict> {
      const index = calls++;
      const current = visits[index];
      if (current === undefined) throw new Error("Unexpected overlapping or extra evaluation");
      active += 1;
      current.signal = signal;
      current.started.resolve();
      try {
        await current.release.promise;
        if (honorSignal) {
          signal.throwIfAborted();
          writes.push(index);
        }
        return { outcome: "passed", message: "mutation completed" };
      } finally {
        active -= 1;
      }
    },
  });
  try {
    await runtime.start([identity(), work({ probes: [probe] })]);
    const gate = z.object({ id: z.string() }).parse(
      await runtime.invoke(
        "gate",
        {
          command: "create",
          title: "Mutation authority",
          probe: "mutation",
        },
        { identity: "operator" },
      ),
    ).id;
    await run({ runtime, clock, visits, writes, active: () => active, gate, database });
  } finally {
    for (const current of visits) current.release.resolve();
    await runtime.stop();
    await rm(dir, { recursive: true, force: true });
  }
}
