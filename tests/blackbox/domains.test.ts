import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sql, Runtime, ManualClock, type Context, type Extension } from "@botlake/core";
import { batteries } from "@botlake/extension-batteries";
import { Cron, defineJob, nextFire } from "@botlake/extension-cron";
import { identity } from "@botlake/extension-identity";
import { kanban } from "@botlake/extension-kanban";
import { z } from "zod";

import { rejected } from "./assert.ts";

const node = z.object({ id: z.string(), attributes: z.record(z.string(), z.json()) });

test("Kanban preserves ownership evidence and fences generic writes, batch burns, links and stale references", async () => {
  await world([batteries(), identity(), kanban()], new ManualClock(1000), async (runtime) => {
    const invoke = (input: unknown): Promise<unknown> => runtime.invoke("kanban", input);
    const epic = node.parse(await invoke({ command: "add", title: "Epic", type: "epic" }));
    const feature = node.parse(await invoke({ command: "add", title: "Feature", epic: epic.id }));

    expect(
      z
        .array(node)
        .parse(await runtime.invoke("ready", { query: "kanban-pending" }))
        .map((row) => row.id),
    ).toEqual([feature.id]);

    const task = node.parse(await invoke({ command: "task", feature: feature.id, title: "Task" }));
    const claim = z
      .object({ result: z.string(), claim: node })
      .parse(
        await invoke({ command: "claim", id: feature.id, owner: "unresolved", branch: "topic" }),
      );
    expect(
      z
        .object({ result: z.string() })
        .parse(
          await invoke({ command: "claim", id: feature.id, owner: "unresolved", branch: "topic" }),
        ).result,
    ).toBe("unchanged");

    expect(() => runtime.graph.update(claim.claim.id, { title: "forged" })).toThrow("immutable");
    expect(() => runtime.graph.batch({ refs: { claim: claim.claim.id }, burn: ["claim"] })).toThrow(
      "immutable",
    );
    expect(
      (
        await rejected(
          invoke({ command: "claim", id: feature.id, owner: "unresolved", branch: "different" }),
        )
      ).message,
    ).toContain("ambiguous");
    await invoke({ command: "claim", id: feature.id, owner: "second", branch: "next" });
    await invoke({ command: "claim", id: feature.id, owner: "unresolved", branch: "topic" });
    const history = z
      .object({ history: z.array(node) })
      .parse(await invoke({ command: "card", id: feature.id })).history;
    expect(history.map((entry) => entry.attributes["kanban/owner"])).toEqual([
      "unresolved",
      "second",
      "unresolved",
    ]);

    const times = history.map((entry) =>
      Date.parse(z.string().parse(entry.attributes["kanban/claimed-at"])),
    );
    expect(times[0]).toBeLessThan(times[1] ?? 0);
    expect(times[1]).toBeLessThan(times[2] ?? 0);
    const view = z
      .object({
        tasks: z.array(z.object({ status: z.string(), owner: z.object({ source: z.string() }) })),
      })
      .parse(await invoke({ command: "card", id: feature.id }));
    expect(view.tasks[0]?.status).toBe("ready");
    expect(view.tasks[0]?.owner.source).toBe("inherited");

    await invoke({ command: "claim", id: task.id, owner: "worker" });
    expect(
      z
        .object({ tasks: z.array(z.object({ status: z.string() })) })
        .parse(await invoke({ command: "card", id: feature.id })).tasks[0]?.status,
    ).toBe("doing");

    await invoke({
      command: "ref",
      operation: "add",
      id: feature.id,
      url: "https://example.com/a?x=1#b",
    });
    expect(
      (
        await rejected(
          invoke({
            command: "ref",
            operation: "add",
            id: feature.id,
            url: "https://example.com/b",
            expectedRevision: 1,
          }),
        )
      ).message,
    ).toContain("Stale");
    expect(() =>
      runtime.graph.update(feature.id, {
        attributes: { "kanban/external-refs": [{ url: "file:///etc/passwd" }] },
      }),
    ).toThrow();

    await invoke({ command: "finish", id: epic.id, outcome: "abandoned" });
    expect(runtime.graph.show(task.id).attributes["kanban/outcome"]).toBe("unactioned");
    await invoke({ command: "reopen", id: epic.id });
    expect(runtime.graph.show(feature.id).state).toBe("active");
    expect(runtime.graph.show(task.id).state).toBe("active");
    const native = await runtime.invoke("identity", {
      command: "startup",
      provider: "codex",
      nativeSessionId: "actual",
    });
    expect(
      await runtime.invoke("identity", {
        command: "startup",
        provider: "codex",
        nativeSessionId: "actual",
      }),
    ).toEqual({
      ...z
        .object({ identity: z.string(), nodeId: z.string(), instruction: z.string() })
        .parse(native),
      result: "recovered",
    });
  });
});

test("calendar parser handles spring and fall DST and interval jobs retain cadence on restart", async () => {
  const calendar = { expression: "0 9 * * *", timezone: "Europe/London" };
  expect(new Date(nextFire(calendar, Date.parse("2026-03-28T09:00:00Z"))).toISOString()).toBe(
    "2026-03-29T08:00:00.000Z",
  );
  expect(new Date(nextFire(calendar, Date.parse("2026-10-24T08:00:00Z"))).toISOString()).toBe(
    "2026-10-25T09:00:00.000Z",
  );
  const transition = { expression: "30 1 * * *", timezone: "Europe/London" };
  expect(new Date(nextFire(transition, Date.parse("2026-03-28T01:30:00Z"))).toISOString()).toBe(
    "2026-03-29T01:30:00.000Z",
  );
  expect(new Date(nextFire(transition, Date.parse("2026-10-24T00:30:00Z"))).toISOString()).toBe(
    "2026-10-25T00:30:00.000Z",
  );
  expect(new Date(nextFire(transition, Date.parse("2026-10-25T00:30:00Z"))).toISOString()).toBe(
    "2026-10-26T01:30:00.000Z",
  );
  const clock = new ManualClock(0);
  const ids: string[] = [];
  let cron: Cron | undefined;
  const extension: Extension = {
    name: "jobs",
    activate(ctx: Context) {
      const service = new Cron(
        ctx,
        [
          defineJob({
            id: "tick",
            action: "tick",
            schedule: { everyMs: 1000 },
            missed: "catch-up",
            overlap: "queue",
          }),
        ],
        {
          tick: (_, occurrence) => {
            ids.push(occurrence.id);
          },
        },
      );
      cron = service;
      ctx.resource(service);
    },
  };
  await world([extension], clock, async (runtime, path) => {
    clock.advance(3500);
    await runtime.drain();
    await cron?.drain();
    expect(ids).toEqual(["tick/1000", "tick/2000", "tick/3000"]);
    expect(z.array(z.object({ next_at: z.number() })).parse(cron?.status())[0]?.next_at).toBe(4000);
    await runtime.stop();
    const second = new Runtime({ database: path, clock });
    try {
      await second.start([extension]);
      expect(z.array(z.object({ next_at: z.number() })).parse(cron?.status())[0]?.next_at).toBe(
        4000,
      );
      clock.advance(4000);
      await second.drain();
      await cron?.drain();
      expect(ids.at(-1)).toBe("tick/4000");
    } finally {
      await second.stop();
    }
  });
});

test("cron overlap and retry outcomes retain occurrence IDs and attempt evidence", async () => {
  const clock = new ManualClock(0);
  const gate = Promise.withResolvers<void>();
  let service: Cron | undefined;
  let attempts = 0;
  const extension: Extension = {
    name: "jobs",
    activate(ctx) {
      service = new Cron(
        ctx,
        [
          defineJob({
            id: "blocked",
            action: "blocked",
            schedule: { everyMs: 1000 },
            overlap: "skip",
          }),
          defineJob({
            id: "retry",
            action: "retry",
            schedule: { everyMs: 10000 },
            retry: { attempts: 1, delayMs: 500 },
          }),
        ],
        {
          blocked: async () => {
            await gate.promise;
          },
          retry: () => {
            attempts++;
            if (attempts === 1) throw new Error("first attempt");
          },
        },
      );
      ctx.resource(service);
    },
  };
  await world([extension], clock, async (runtime) => {
    clock.advance(1000);
    await runtime.drain();
    clock.advance(2000);
    await runtime.drain();
    expect(
      z
        .array(z.object({ status: z.string() }))
        .parse(service?.history("blocked"))
        .map((row) => row.status),
    ).toEqual(["running", "skipped"]);
    gate.resolve();
    await service?.drain();
    clock.advance(10000);
    await runtime.drain();
    await service?.drain();
    clock.advance(10500);
    await runtime.drain();
    await service?.drain();
    const history = z
      .array(z.object({ id: z.string(), attempt: z.number(), status: z.string() }))
      .parse(service?.history("retry"));
    expect(history).toEqual([{ id: "retry/10000", attempt: 2, status: "succeeded" }]);
  });
});

test("missed-run policies tolerate timer jitter and namespaced jobs do not overlap each other", async () => {
  const clock = new ManualClock(0);
  const gate = Promise.withResolvers<void>();
  let service: Cron | undefined;
  const extension: Extension = {
    name: "policy",
    activate(ctx) {
      service = new Cron(
        ctx,
        [
          defineJob({ id: "foo/bar", action: "block", schedule: { everyMs: 1000 } }),
          defineJob({ id: "foo", action: "done", schedule: { everyMs: 2000 } }),
          defineJob({ id: "skip", action: "done", schedule: { everyMs: 1000 }, missed: "skip" }),
          defineJob({ id: "once", action: "done", schedule: { everyMs: 1000 }, missed: "once" }),
        ],
        {
          block: async () => {
            await gate.promise;
          },
          done: () => null,
        },
      );
      ctx.resource(service);
    },
  };
  await world([extension], clock, async (runtime) => {
    clock.advance(1001);
    await runtime.drain();
    expect(
      z.array(z.object({ status: z.string() })).parse(service?.history("skip"))[0]?.status,
    ).toBe("succeeded");
    clock.advance(3500);
    await runtime.drain();
    expect(
      z.array(z.object({ status: z.string() })).parse(service?.history("foo"))[0]?.status,
    ).toBe("succeeded");
    expect(
      z.array(z.object({ status: z.string() })).parse(service?.history("skip"))[1]?.status,
    ).toBe("skipped");
    expect(
      z
        .array(z.object({ scheduled_at: z.number() }))
        .parse(service?.history("once"))
        .map((row) => row.scheduled_at),
    ).toEqual([1000, 3000]);
    gate.resolve();
    await service?.drain();
  });
});

test("Cron recovers an interrupted occurrence with its stable ID and preserved attempt history", async () => {
  const clock = new ManualClock(0);
  const seen: string[] = [];
  let service: Cron | undefined;
  const extension: Extension = {
    name: "recovery",
    activate(ctx) {
      service = new Cron(
        ctx,
        [defineJob({ id: "recover", action: "done", schedule: { everyMs: 1000 } })],
        {
          done: (_, occurrence) => {
            seen.push(occurrence.id);
          },
        },
      );
      ctx.resource(service);
    },
  };
  await world([extension], clock, async (runtime, path) => {
    // Durable state left by an interrupted handler, before it could record an outcome.
    runtime.graph.db
      .query(sql`
        INSERT INTO cron_occurrences (id, job, scheduled_at, status, attempt)
        VALUES ('recover/0', 'recover', 0, 'running', 1)
      `)
      .run();
    await runtime.stop();
    const recovered = new Runtime({ database: path, clock });
    try {
      await recovered.start([extension]);
      await service?.drain();
      expect(seen).toEqual(["recover/0"]);
      expect(
        z
          .array(z.object({ attempt: z.number(), status: z.string() }))
          .parse(service?.history("recover")),
      ).toEqual([{ attempt: 2, status: "succeeded" }]);
    } finally {
      await recovered.stop();
    }
  });
});

test("Cron allows explicitly concurrent occurrences and persists exhausted failures", async () => {
  const clock = new ManualClock(0);
  const gate = Promise.withResolvers<void>();
  let service: Cron | undefined;
  const extension: Extension = {
    name: "concurrent-jobs",
    activate(ctx) {
      service = new Cron(
        ctx,
        [
          defineJob({
            id: "parallel",
            action: "block",
            schedule: { everyMs: 1000 },
            overlap: "allow",
          }),
          defineJob({ id: "failure", action: "fail", schedule: { everyMs: 1000 } }),
        ],
        {
          block: async () => {
            await gate.promise;
          },
          fail: () => {
            throw new Error("action failed");
          },
        },
      );
      ctx.resource(service);
    },
  };
  await world([extension], clock, async (runtime) => {
    try {
      clock.advance(1000);
      await runtime.drain();
      clock.advance(2000);
      await runtime.drain();
      const outcomes = z.array(
        z.object({
          id: z.string(),
          status: z.string(),
          attempt: z.number(),
          error: z.string().nullable(),
        }),
      );
      expect(outcomes.parse(service?.history("parallel")).map((entry) => entry.status)).toEqual([
        "running",
        "running",
      ]);
      expect(outcomes.parse(service?.history("failure"))).toEqual([
        { id: "failure/1000", status: "failed", attempt: 1, error: "Error: action failed" },
        { id: "failure/2000", status: "failed", attempt: 1, error: "Error: action failed" },
      ]);
    } finally {
      gate.resolve();
      await service?.drain();
    }
    expect(
      z
        .array(z.object({ status: z.string() }))
        .parse(service?.history("parallel"))
        .map((entry) => entry.status),
    ).toEqual(["succeeded", "succeeded"]);
  });
});

// -- Private helpers --

async function world(
  extensions: Extension[],
  clock: ManualClock,
  run: (runtime: Runtime, path: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "botlake-domains-"));
  const path = join(dir, "world.db");
  const runtime = new Runtime({ database: path, clock });
  try {
    await runtime.start(extensions);

    await run(runtime, path);
  } finally {
    await runtime.stop();
    await rm(dir, { recursive: true, force: true });
  }
}
