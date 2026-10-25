import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as v from "valibot";
import { z } from "zod";

import { Runtime, batteries, ManualClock, defineOp, type Spool } from "../../src/index.ts";
import { isStream } from "../../src/runtime/runtime.ts";
import { rejected } from "./assert.ts";

async function disposable(
  run: (runtime: Runtime) => Promise<void>,
  spools: Spool[] = [batteries()],
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "millstrand-"));
  const runtime = new Runtime({ database: join(dir, "world.db") });
  try {
    await runtime.start(spools);
    await run(runtime);
  } finally {
    await runtime.stop();
    await rm(dir, { recursive: true, force: true });
  }
}

test("graph mutations, archive selection, stale writes and atomic rollback through public ops", async () => {
  await disposable(async (runtime) => {
    const graph = runtime.graph;
    const a = graph.add({ title: "A", attributes: { "ns/key": "", nested: { a: 1, b: 2 } } });
    const b = graph.add({ title: "B" });
    graph.connect(a.id, b.id, "depends-on");
    expect(graph.list({ ready: true }).map((row) => row.id)).toEqual([b.id]);
    expect(() => graph.connect(b.id, a.id, "depends-on")).toThrow("Cycle");
    expect(() => graph.update(a.id, { title: "stale", expectedRevision: 100 })).toThrow("Stale");
    graph.update(a.id, { attributes: { nested: { a: null }, "ns/key": "" } });
    expect(graph.show(a.id).attributes).toEqual({ "ns/key": "", nested: { b: 2 } });
    graph.archive(a.id, ["ns/key"]);
    expect(graph.show(a.id).attributes["ns/key"]).toBe("");
    expect(graph.list({ where: { op: "exists", field: { attr: "ns/key", path: [] } } })).toEqual(
      [],
    );
    expect(
      graph.list({
        where: { op: "=", field: "title", value: { param: "title" } },
        params: { title: "' OR 1=1 --" },
      }),
    ).toEqual([]);
    expect(() =>
      graph.batch({
        refs: { a: a.id, b: b.id },
        strands: [{ ref: "new", title: "never" }],
        edges: [{ op: "upsert", from: "b", to: "a", relation: "depends-on" }],
      }),
    ).toThrow("Cycle");
    expect(graph.list().map((row) => row.title)).not.toContain("never");
    const replacement = graph.add({ title: "replacement" });
    graph.supersede(b.id, replacement.id);
    expect(graph.edge(a.id, replacement.id, "depends-on")).not.toBeNull();
    const note = graph.note(a.id, "immutable");
    expect(() => graph.update(note.id, { attributes: { "note/text": null } })).toThrow("Immutable");
    graph.burn([a.id, replacement.id]);
    expect(graph.tombstones(a.id)).toHaveLength(1);
    expect(graph.tombstones(replacement.id)).toHaveLength(1);
    expect(await runtime.invoke("help", [])).toBeArray();
    expect(await runtime.invoke("about", ["list"])).toBeArray();
  });
});

test("async Zod and Valibot transformations, discovery, output validation and stream framing", async () => {
  const zod = defineOp({
    name: "zod",
    input: z.string().transform(async (value) => value.length),
    output: z.number().transform(async (value) => ({ value })),
    cli: { description: "async" },
    handler: (length) => length + 1,
  });
  const valibot = defineOp({
    name: "valibot",
    input: v.pipeAsync(
      v.string(),
      v.transformAsync(async (value) => value.length),
    ),
    output: v.pipeAsync(
      v.number(),
      v.transformAsync(async (value) => `result:${value}`),
    ),
    cli: { description: "async" },
    handler: (length) => length + 2,
  });
  const bad = defineOp({
    name: "bad",
    input: z.object({}),
    output: z.number().min(1),
    cli: { description: "bad output" },
    handler: () => 0,
  });
  const stream = defineOp({
    name: "stream",
    input: z.object({}),
    output: z.number().min(1),
    stream: true,
    cli: { description: "stream" },
    async *handler() {
      yield 1;
      yield 0;
    },
  });
  await disposable(
    async (runtime) => {
      expect(await runtime.invoke("zod", "abc")).toEqual({ value: 4 });
      expect(await runtime.invoke("valibot", "abc")).toBe("result:5");
      expect((await rejected(runtime.invoke("bad", {}))).message).toContain("validation");
      const result = await runtime.invoke("stream", {});
      const values: unknown[] = [];
      expect(
        (
          await rejected(
            (async () => {
              if (isStream(result)) for await (const item of result) values.push(item);
            })(),
          )
        ).message,
      ).toContain("validation");
      expect(values).toEqual([1]);
    },
    [
      {
        name: "validation",
        activate(ctx) {
          for (const op of [zod, valibot, bad, stream]) ctx.register(op);
        },
      },
    ],
  );
});

test("failed startup disposes resources and durable wake cancellation fences a running generation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "millstrand-clock-"));
  const clock = new ManualClock(1000);
  let stopped = false;
  const failed = new Runtime({ database: join(dir, "failed.db"), clock });
  expect(
    (
      await rejected(
        failed.start([
          {
            name: "failure",
            activate(ctx) {
              ctx.resource({
                start() {
                  throw new Error("start failed");
                },
                stop() {
                  stopped = true;
                },
              });
            },
          },
        ]),
      )
    ).message,
  ).toContain("start failed");
  expect(stopped).toBe(true);
  const runtime = new Runtime({ database: join(dir, "world.db"), clock });
  let delivered = 0;
  await runtime.start([
    {
      name: "wakes",
      activate(ctx) {
        ctx.scheduler.register("count", () => {
          delivered++;
          ctx.scheduler.schedule("same", 3000, "count");
        });
      },
    },
  ]);
  runtime.scheduler.schedule("same", 2000, "count");
  clock.advance(2000);
  await runtime.drain();
  expect(delivered).toBe(1);
  expect(runtime.scheduler.pending()[0]?.at).toBe(3000);
  runtime.scheduler.cancel("same");
  await runtime.stop();
  await rm(dir, { recursive: true, force: true });
});

test("a due wake cancelled or replaced by an earlier handler never receives stale authority", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mill-wake-fence-"));
  const clock = new ManualClock(0);
  const runtime = new Runtime({ database: join(dir, "world.db"), clock });
  const calls: string[] = [];
  try {
    await runtime.start([
      {
        name: "fence",
        activate(ctx) {
          ctx.scheduler.register("first", () => {
            calls.push("first");
            ctx.scheduler.cancel("b");
            ctx.scheduler.schedule("b", 2000, "second");
          });
          ctx.scheduler.register("second", () => {
            calls.push("second");
          });
        },
      },
    ]);
    runtime.scheduler.schedule("a", 1000, "first");
    runtime.scheduler.schedule("b", 1000, "second");
    clock.advance(1000);
    await runtime.drain();
    expect(calls).toEqual(["first"]);
    clock.advance(2000);
    await runtime.drain();
    expect(calls).toEqual(["first", "second"]);
  } finally {
    await runtime.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("events follow commit, rollback stays silent, and nested domain authority does not leak", async () => {
  const { identity, reserveIdentity } = await import("../../src/index.ts");
  const committed: number[] = [];
  await disposable(
    async (runtime) => {
      expect(() =>
        runtime.graph.atomic(() => {
          runtime.graph.add({ title: "rolled back" });
          throw new Error("abort");
        }),
      ).toThrow("abort");
      await runtime.drain();
      expect(committed).toEqual([]);
      runtime.graph.atomic(() => {
        runtime.graph.add({ title: "one" });
        runtime.graph.add({ title: "two" });
      });
      await runtime.drain();
      expect(committed).toEqual([2]);
      expect(() => {
        runtime.graph.atomic(() => {
          const reserved = reserveIdentity(runtime.context, { harness: "codex" });
          runtime.graph.update(reserved.strandId, { title: "forged" });
        });
      }).toThrow("Identity API");
      await runtime.drain();
      expect(committed).toEqual([2]);
    },
    [
      identity(),
      {
        name: "observer",
        activate(ctx) {
          ctx.subscribe((event) => {
            for (const change of event.changes)
              if (change.kind === "strand" && change.after !== null)
                ctx.graph.show(change.after.id);
            committed.push(event.changes.length);
          });
        },
      },
    ],
  );
});
