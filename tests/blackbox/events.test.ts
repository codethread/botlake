import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Runtime, isStream, type Context } from "@botlake/core";
import { agentsChanged } from "@botlake/extension-agents";
import { identity } from "@botlake/extension-identity";
import { work, workChanged, workAssignmentEstablished, workStore } from "@botlake/extension-work";
import { z } from "zod";

import { rejected } from "./assert.ts";
import { system } from "./fixtures/system.ts";

const item = z.object({ id: z.string() });
const notification = z.object({
  type: z.literal("event"),
  event: z.string(),
  data: z.object({ ids: z.array(z.string()) }),
});

test("assignment hooks share rollback while committed notifications remain lake-local and cancellable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "botlake-events-"));
  const runtime = new Runtime({ database: join(dir, "lake.sqlite") });
  const other = new Runtime({ database: join(dir, "other.sqlite") });
  const changed: string[][] = [];
  const others: string[][] = [];
  let rejectBinding = true;
  let observedContext: Context | undefined;
  try {
    await runtime.start([
      identity(),
      work(),
      {
        name: "binding-probe",
        requires: ["work"],
        activate(ctx) {
          observedContext = ctx;
          ctx.on(workChanged, ({ ids }) => {
            changed.push(ids);
          });
          ctx.on(workAssignmentEstablished, ({ assignment }) => {
            ctx.graph.add({ title: "Binding probe", attributes: { assignment: assignment.id } });
            if (rejectBinding) throw new Error("Binding persistence failed");
          });
        },
      },
    ]);
    await other.start([
      identity(),
      work(),
      {
        name: "observer",
        requires: ["work"],
        activate(ctx) {
          ctx.on(workChanged, ({ ids }) => {
            others.push(ids);
          });
        },
      },
    ]);
    const store = workStore(runtime.context);
    expect(() =>
      store.create({ kind: "task", title: "Rolled back", assignee: "owner", by: "author" }),
    ).toThrow("Binding persistence failed");
    await runtime.drain();
    expect(runtime.graph.all()).toEqual([]);
    expect(changed).toEqual([]);

    rejectBinding = false;
    const created = store.create({
      kind: "task",
      title: "Assigned",
      assignee: "owner",
      by: "author",
    });
    await runtime.drain();
    expect(changed).toEqual([[created.id]]);
    expect(others).toEqual([]);
    const first = store.get(created.id);
    if (first.kind !== "task" || first.assignment === null)
      throw new Error("Expected assigned task");
    const assignment = first.assignment;
    expect(store.claim(created.id, "owner", "author").id).toBe(first.assignment.id);
    expect(runtime.graph.all().filter((node) => node.title === "Binding probe")).toHaveLength(2);

    const unsubscribe = runtime.context.on(workChanged, () => {
      throw new Error("Observer failed");
    });
    store.update(created.id, { notes: "Committed result" });
    await runtime.drain();
    expect(store.get(created.id)).toMatchObject({ notes: "Committed result" });
    expect(runtime.errors.map(String)).toEqual(["Error: Observer failed"]);
    unsubscribe();
    store.update(created.id, { notes: "Still committed" });
    await runtime.drain();
    expect(runtime.errors).toHaveLength(1);
    expect(observedContext).toBe(runtime.context);

    const controller = new AbortController();
    const stream = await runtime.invoke(
      "events",
      { command: "stream", events: [workChanged.name] },
      { signal: controller.signal },
    );
    if (!isStream(stream)) throw new Error("Expected event stream");
    const iterator = stream[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual({ type: "ready", events: ["work.changed"] });
    const before = changed.length;
    expect(() =>
      runtime.graph.atomic(() => {
        store.update(created.id, { notes: "Never published" });
        runtime.context.emit(workChanged, { ids: ["rolled-back-notification"] });
        throw new Error("Abort outer transaction");
      }),
    ).toThrow("Abort outer transaction");
    await runtime.drain();
    expect(changed).toHaveLength(before);
    store.update(created.id, { notes: "Visible" });
    await runtime.drain();
    expect(notification.parse((await iterator.next()).value).data.ids).toEqual([created.id]);
    const blockedRead = iterator.next();
    controller.abort(new Error("Consumer disconnected"));
    expect((await rejected(blockedRead)).message).toContain("Consumer disconnected");
    expect(() => {
      runtime.context.emit(workAssignmentEstablished, {
        task: created.id,
        assignment,
      });
    }).toThrow("requires graph.atomic");

    const mutate = runtime.context.on(workChanged, ({ ids }) => {
      ids.length = 0;
    });
    const intact: string[][] = [];
    const read = runtime.context.on(workChanged, ({ ids }) => {
      intact.push(ids);
    });
    runtime.context.emit(workChanged, { ids: [created.id] });
    await runtime.drain();
    expect(intact).toEqual([[created.id]]);
    mutate();
    read();

    const overflow = await runtime.invoke("events", {
      command: "stream",
      events: [workChanged.name],
    });
    if (!isStream(overflow)) throw new Error("Expected event stream");
    const slow = overflow[Symbol.asyncIterator]();
    await slow.next();
    for (let i = 0; i < 257; i++) runtime.context.emit(workChanged, { ids: [created.id] });
    await runtime.drain();
    expect((await rejected(slow.next())).message).toContain("fell behind");
  } finally {
    await other.stop();
    await runtime.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("public CLI lists contracts and streams filtered committed changes with a ready handshake", async () => {
  const host = await system();
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const workspace = await host.workspace("events", [
      "@botlake/extension-identity",
      "@botlake/extension-work",
      "@botlake/extension-flags",
      "@botlake/extension-agents",
    ]);
    await host.botlake(["lake", "start", "--workspace", workspace]);
    const definitions = z
      .array(z.object({ name: z.string(), phase: z.string(), schema: z.unknown() }))
      .parse(await host.cli(["--workspace", workspace, "events", "list"]));
    expect(definitions.map((event) => event.name).toSorted()).toEqual(
      [agentsChanged.name, workAssignmentEstablished.name, workChanged.name].toSorted(),
    );
    expect(definitions.find((event) => event.name === workAssignmentEstablished.name)?.phase).toBe(
      "transactional",
    );
    const prefix = ["--workspace", workspace];
    child = Bun.spawn([host.blBin, ...prefix, "events", "stream", "--event", workChanged.name], {
      cwd: host.dir,
      env: host.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (child.stdout === undefined || child.stdout === null || typeof child.stdout === "number")
      throw new Error("Expected stream stdout");
    const lines = jsonLines(child.stdout)[Symbol.asyncIterator]();
    expect((await lines.next()).value).toEqual({ type: "ready", events: [workChanged.name] });
    await host.bl(workspace, "agent", {
      command: "native",
      provider: "codex",
      nativeSessionId: "events-native",
      cwd: workspace,
      event: "session-start",
      audience: "agent",
    });
    const created = item.parse(
      await host.bl(workspace, "work", {
        command: "create",
        title: "Streamed task",
        by: "fixture",
      }),
    );
    expect(notification.parse((await lines.next()).value)).toMatchObject({
      event: workChanged.name,
      data: { ids: [created.id] },
    });
    await host.bl(workspace, "work", { command: "update", id: created.id, notes: "Result" });
    expect(notification.parse((await lines.next()).value).data.ids).toEqual([created.id]);
    const failure = await host.cli(
      [...prefix, "events", "stream", "--event", workAssignmentEstablished.name],
      false,
    );
    expect(String(failure)).toContain("Expected a registered after-commit event");
    expect(
      String(await host.cli([...prefix, "events", "stream", "--event", "missing"], false)),
    ).toContain("Expected a registered after-commit event");
  } finally {
    child?.kill();
    await child?.exited;
    await host.close();
  }
}, 60000);

// -- Private helpers --

async function* jsonLines(stream: ReadableStream<Uint8Array>): AsyncGenerator {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    for (;;) {
      const end = buffer.indexOf("\n");
      if (end < 0) break;
      yield JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
    }
  }
}
