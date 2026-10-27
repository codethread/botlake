import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Runtime, ManualClock, type GraphEvent } from "@botlake/core";

test("nested failures roll back graph writes, notifications and timer changes without losing committed wakes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "botlake-transactions-"));
  const clock = new ManualClock(0);
  const runtime = new Runtime({ database: join(dir, "world.db"), clock });
  const delivered: string[] = [];
  const events: GraphEvent[] = [];
  try {
    await runtime.start([
      {
        name: "transactions",
        activate(ctx) {
          ctx.scheduler.register("record", (wake) => {
            delivered.push(wake.key);
          });
          ctx.subscribe((event) => {
            events.push(event);
          });
          ctx.graph.protect((changes) => {
            if (
              changes.some((change) => change.kind === "node" && change.after?.title === "denied")
            )
              throw new Error("commit denied");
          });
        },
      },
    ]);
    const { graph, scheduler } = runtime;
    scheduler.schedule("kept", 100, "record");
    expect(() => {
      graph.atomic(() => {
        scheduler.cancel("kept");
        scheduler.schedule("kept", 500, "record");
        graph.add({ title: "denied" });
      });
    }).toThrow("commit denied");
    expect(scheduler.pending()).toMatchObject([{ key: "kept", at: 100 }]);
    expect(scheduler.history()).toEqual([]);
    clock.advance(100);
    await runtime.drain();
    expect(delivered).toEqual(["kept"]);
    expect(events).toEqual([]);

    scheduler.schedule("retained", 200, "record");
    graph.atomic(() => {
      graph.add({ title: "outer before" });
      expect(() =>
        graph.atomic(() => {
          graph.add({ title: "inner rolled back" });
          scheduler.cancel("retained");
          scheduler.schedule("phantom", 150, "record");
          throw new Error("abort inner");
        }),
      ).toThrow("abort inner");
      graph.add({ title: "outer after" });
      scheduler.schedule("committed", 300, "record");
    });
    await runtime.drain();
    expect(
      graph
        .list()
        .map((row) => row.title)
        .toSorted(),
    ).toEqual(["outer after", "outer before"]);
    expect(events).toHaveLength(1);
    expect(events[0]?.changes).toHaveLength(2);
    expect(scheduler.pending().map((wake) => wake.key)).toEqual(["retained", "committed"]);
    clock.advance(200);
    await runtime.drain();
    expect(delivered).toEqual(["kept", "retained"]);
    clock.advance(300);
    await runtime.drain();
    expect(delivered).toEqual(["kept", "retained", "committed"]);
    expect(scheduler.pending()).toEqual([]);
  } finally {
    await runtime.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("supersession preserves existing dependencies and rejects repeated replacement, cycles and aliased batch identities", async () => {
  const dir = await mkdtemp(join(tmpdir(), "botlake-supersession-"));
  const runtime = new Runtime({ database: join(dir, "world.db") });
  const events: GraphEvent[] = [];
  try {
    await runtime.start([
      {
        name: "observer",
        activate(ctx) {
          ctx.subscribe((event) => {
            events.push(event);
          });
        },
      },
    ]);
    const graph = runtime.graph;
    const old = graph.add({ title: "old", state: "closed" });
    const replacement = graph.add({ title: "replacement" });
    const dependent = graph.add({ title: "dependent", state: "closed" });
    graph.connect(dependent.id, old.id, "depends-on", { reason: "old" });
    graph.connect(dependent.id, replacement.id, "depends-on", { reason: "existing" });
    graph.supersede(old.id, replacement.id);
    expect(graph.show(old.id).state).toBe("replaced");
    expect(graph.edge(replacement.id, old.id, "supersedes")).not.toBeNull();
    expect(graph.edge(dependent.id, replacement.id, "depends-on")?.attributes).toEqual({
      reason: "existing",
    });
    expect(graph.edge(dependent.id, old.id, "depends-on")).toBeNull();
    const other = graph.add({ title: "other" });
    await runtime.drain();
    events.length = 0;
    expect(() => graph.supersede(old.id, other.id)).toThrow("already replaced");
    expect(() =>
      graph.batch({
        refs: { a: other.id, alias: other.id },
        nodes: [{ ref: "a", title: "overwritten" }],
        burn: ["alias"],
      }),
    ).toThrow("Duplicate node in refs");
    expect(graph.show(other.id).title).toBe("other");
    expect(graph.tombstones(other.id)).toEqual([]);
    await runtime.drain();
    expect(events).toEqual([]);

    const active = graph.add({ title: "active" });
    graph.connect(other.id, active.id, "depends-on");
    const before = graph.show(active.id);
    await runtime.drain();
    events.length = 0;
    expect(() => graph.supersede(active.id, other.id)).toThrow("Cycle");
    expect(graph.show(active.id)).toEqual(before);
    expect(graph.edge(other.id, active.id, "depends-on")).not.toBeNull();
    expect(graph.edge(other.id, active.id, "supersedes")).toBeNull();
    await runtime.drain();
    expect(events).toEqual([]);
  } finally {
    await runtime.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
