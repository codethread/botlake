import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  Runtime,
  ManualClock,
  defineOp,
  q,
  isStream,
  type GraphEvent,
  type Predicate,
  type Extension,
} from "@botlake/core";
import { batteries } from "@botlake/extension-batteries";
import * as v from "valibot";
import { z } from "zod";

import { rejected } from "./assert.ts";

async function disposable(
  run: (runtime: Runtime) => Promise<void>,
  extensions: Extension[] = [batteries()],
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "botlake-"));
  const runtime = new Runtime({ database: join(dir, "world.db") });
  try {
    await runtime.start(extensions);

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
    expect(graph.list({ where: q.exists(q.attr("ns/key")) })).toEqual([]);
    expect(
      graph.list({
        where: q.eq("title", q.param("title")),
        params: { title: "' OR 1=1 --" },
      }),
    ).toEqual([]);
    expect(() =>
      graph.batch({
        refs: { a: a.id, b: b.id },
        nodes: [{ ref: "new", title: "never" }],
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

test("archival preserves immutable evidence and burn records each deletion exactly once", async () => {
  const events: GraphEvent[] = [];
  await disposable(
    async (runtime) => {
      const graph = runtime.graph;
      const target = graph.add({ title: "target" });
      const note = graph.note(target.id, "source", { scratch: "extra" });
      await runtime.drain();
      events.length = 0;
      expect(
        (
          await rejected(
            runtime.invoke("archive", {
              id: note.id,
              keys: ["scratch", "note/text"],
            }),
          )
        ).message,
      ).toContain("Immutable");
      expect(
        (
          await rejected(
            runtime.invoke("archive", {
              id: note.id,
              keys: ["scratch", "typo"],
            }),
          )
        ).message,
      ).toContain("Unknown attribute");
      expect(graph.show(note.id, true)).toEqual(note);
      expect(
        (await rejected(runtime.invoke("burn", { ids: [target.id, target.id] }))).message,
      ).toContain("Duplicate node");
      expect(
        (
          await rejected(
            runtime.invoke("batch", {
              refs: { a: target.id, alias: target.id },
              nodes: [{ ref: "new", title: "rolled back" }],
              burn: ["a", "alias"],
            }),
          )
        ).message,
      ).toContain("Duplicate node");
      expect(graph.list()).toHaveLength(2);
      expect(graph.tombstones(target.id)).toEqual([]);
      await runtime.drain();
      expect(events).toEqual([]);
      await runtime.invoke("archive", { id: note.id, keys: ["scratch"] });
      expect(graph.show(note.id, true).attributes).not.toHaveProperty("scratch");
      expect(graph.show(note.id).attributes["scratch"]).toBe("extra");
      await runtime.drain();
      events.length = 0;
      await runtime.invoke("burn", { ids: [target.id, note.id] });
      await runtime.drain();
      expect(graph.tombstones(target.id)).toHaveLength(1);
      expect(graph.tombstones(note.id)).toHaveLength(1);
      expect(events).toHaveLength(1);
      expect(events[0]?.changes.filter((change) => change.kind === "node")).toHaveLength(2);
      expect(events[0]?.changes.filter((change) => change.kind === "edge")).toHaveLength(1);
    },
    [
      batteries(),
      {
        name: "observer",
        activate(ctx) {
          ctx.subscribe((event) => {
            events.push(event);
          });
        },
      },
    ],
  );
});

test("query negation requires present hot values and composes across named queries and edges", async () => {
  const a: Predicate = q.eq(q.attr("a"), 1);
  const field = q.attr("doc", "value");
  const b: Predicate = q.eq(field, 2);
  await disposable(
    async (runtime) => {
      const graph = runtime.graph;
      graph.add({ title: "missing", attributes: { a: 1 } });
      const nullable = graph.add({ title: "null", attributes: { a: 1, doc: { value: null } } });
      expect(nullable.attributes["doc"]).toEqual({ value: null });
      const matching = graph.add({ title: "matching", attributes: { a: 1, doc: { value: 2 } } });
      const different = graph.add({ title: "different", attributes: { a: 0, doc: { value: 3 } } });
      graph.add({ title: "other", attributes: { a: 1, doc: { value: 3 } } });
      graph.add({ title: "partial", attributes: { a: 0 } });
      const archived = graph.add({ title: "archived", attributes: { a: 1, doc: { value: 3 } } });
      graph.archive(archived.id, ["doc"]);
      const titles = (result: unknown): string[] =>
        z
          .array(z.object({ title: z.string() }))
          .parse(result)
          .map((row) => row.title)
          .toSorted();
      const select = async (where: Predicate): Promise<string[]> =>
        titles(await runtime.invoke("list", { where }));
      expect(await select(q.not(b))).toEqual(["different", "other"]);
      expect(await select(q.not(q.inArray(field, [2])))).toEqual(["different", "other"]);
      expect(await select(q.not(q.and(a, b)))).toEqual(["different", "other", "partial"]);
      expect(await select(q.not(q.or(a, b)))).toEqual(["different"]);
      expect(await select(q.not(q.not(q.and(a, b))))).toEqual(["matching"]);
      expect(await select(q.exists(field))).toEqual(["different", "matching", "other"]);
      expect(await select(q.missing(field))).toEqual(["archived", "missing", "null", "partial"]);
      expect(await select(q.eq(field, null))).toEqual([]);
      expect(await select(q.ne(field, null))).toEqual([]);
      expect(
        titles(await runtime.invoke("list", { query: "different", params: { value: 2 } })),
      ).toEqual(["different", "other"]);
      expect((await rejected(runtime.invoke("list", { query: "different" }))).message).toContain(
        "Missing parameter",
      );
      graph.connect(matching.id, different.id, "ref");
      expect(await select(q.edgeOut("ref", q.not(b)))).toEqual(["matching"]);
      expect(await select(q.not(q.edgeOut("ref")))).toEqual([
        "archived",
        "different",
        "missing",
        "null",
        "other",
        "partial",
      ]);
      const key = 'owner") OR 1=1 --';
      graph.update(matching.id, { attributes: { [key]: { "a.b": { 'quote"key': "safe" } } } });
      expect(await select(q.eq(q.attr(key, "a.b", 'quote"key'), "safe"))).toEqual(["matching"]);
    },
    [
      batteries({
        different: {
          description: "Present values other than the supplied value",
          params: ["value"],
          where: q.not(q.eq(field, q.param("value"))),
        },
      }),
    ],
  );
});

test("batches compose local refs and ordered edges, enforce relation invariants and roll back stale writes", async () => {
  const events: GraphEvent[] = [];
  await disposable(
    async (runtime) => {
      const graph = runtime.graph;
      graph.declareAcyclic("custom");
      const created = graph.batch({
        nodes: ["root", "child", "blocker", "executor"].map((ref) => ({ ref, title: ref })),
        edges: [
          { op: "upsert", from: "root", to: "child", relation: "parent-of" },
          { op: "upsert", from: "child", to: "blocker", relation: "depends-on" },
          { op: "upsert", from: "executor", to: "child", relation: "serves" },
          { op: "upsert", from: "root", to: "child", relation: "custom" },
        ],
      });
      const id = (ref: string): string => z.string().parse(created.refs[ref]);
      expect(
        graph
          .list({ ready: true })
          .map((row) => row.title)
          .toSorted(),
      ).toEqual(["blocker", "executor", "root"]);
      expect(
        graph
          .subgraph(id("root"))
          .nodes.map((row) => row.title)
          .toSorted(),
      ).toEqual(["child", "root"]);
      expect(() => graph.connect(id("child"), id("root"), "custom")).toThrow("Cycle");
      expect(() => graph.connect(id("executor"), id("blocker"), "serves")).toThrow();
      const moved = graph.batch({
        refs: created.refs,
        edges: [
          { op: "remove", from: "executor", to: "child", relation: "serves" },
          {
            op: "upsert",
            from: "executor",
            to: "blocker",
            relation: "serves",
            attributes: { reason: "next" },
          },
        ],
      });
      expect(moved.changes).toMatchObject([
        { kind: "edge", before: { to_id: id("child") }, after: null },
        {
          kind: "edge",
          before: null,
          after: { to_id: id("blocker"), attributes: { reason: "next" } },
        },
      ]);
      const original = graph.show(id("root"));
      graph.update(original.id, { title: "root revised", expectedRevision: original.revision });
      await runtime.drain();
      events.length = 0;
      expect(() =>
        graph.batch({
          refs: created.refs,
          nodes: [
            { ref: "child", title: "must roll back" },
            { ref: "root", title: "stale", expectedRevision: original.revision },
          ],
        }),
      ).toThrow("Stale");
      expect(graph.show(id("child")).title).toBe("child");
      expect(graph.show(original.id).title).toBe("root revised");
      expect(() =>
        graph.batch({
          refs: created.refs,
          nodes: [{ ref: "new", title: "must roll back" }],
          edges: [{ op: "remove", from: "child", to: "root", relation: "parent-of" }],
        }),
      ).toThrow("Unknown edge");
      expect(graph.list()).toHaveLength(4);
      await runtime.drain();
      expect(events).toEqual([]);
      graph.update(id("blocker"), { state: "closed" });
      expect(graph.list({ ready: true }).map((row) => row.title)).toContain("child");
    },
    [
      batteries(),
      {
        name: "observer",
        activate(ctx) {
          ctx.subscribe((event) => {
            events.push(event);
          });
        },
      },
    ],
  );
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
  const dir = await mkdtemp(join(tmpdir(), "botlake-clock-"));
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
  const dir = await mkdtemp(join(tmpdir(), "botlake-wake-fence-"));
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
  const { identity, nativeStartup } = await import("@botlake/extension-identity");
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
          const reserved = nativeStartup(runtime.context, {
            provider: "codex",
            nativeSessionId: "actual",
          });
          runtime.graph.update(reserved.nodeId, { title: "forged" });
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
              if (change.kind === "node" && change.after !== null) ctx.graph.show(change.after.id);
            committed.push(event.changes.length);
          });
        },
      },
    ],
  );
});
