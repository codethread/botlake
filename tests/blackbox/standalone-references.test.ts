import { test, expect } from "bun:test";
import { rename } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { referenceBoard } from "./fixtures/references.ts";
import { system } from "./fixtures/system.ts";

const identifier = z.object({ id: z.string() });
const importedReference = z.object({
  id: z.string(),
  state: z.string(),
  reference: z.object({
    lakeId: z.string(),
    nodeId: z.string(),
    revision: z.number(),
    status: z.enum(["current", "stale", "missing"]),
  }),
});
const referenceList = z.object({ nodes: z.array(importedReference.extend({ title: z.string() })) });
const referenceStatus = z.object({
  sources: z.array(
    z.object({
      lakeId: z.string(),
      state: z.enum(["connecting", "live", "offline"]),
      error: z.object({ code: z.string(), message: z.string() }).nullable(),
    }),
  ),
});
const lakeStatus = z.object({ pid: z.number(), ready: z.boolean() });

async function eventually<T>(read: () => Promise<T>, accepts: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const value = await read();
    if (accepts(value)) return value;
    if (Date.now() >= deadline) throw new Error("Timed out waiting for reference state");
    await Bun.sleep(50);
  }
}

test("standalone lakes keep reference ownership and refresh across planned source restarts", async () => {
  const host = await system();
  let watch: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  try {
    const source = await referenceBoard(host, "reference-owner");
    const consumer = await referenceBoard(host, "reference-consumer");
    for (const workspace of [source, consumer])
      await host.botlake(["lake", "start", "--workspace", workspace]);
    const readReference = async () =>
      referenceList.parse(await host.bl(consumer, "reference-fixture", { command: "list" }))
        .nodes[0];

    const sourceProcess = lakeStatus.parse(
      await host.botlake(["lake", "status", "--workspace", source]),
    );
    const consumerProcess = lakeStatus.parse(
      await host.botlake(["lake", "status", "--workspace", consumer]),
    );
    expect(sourceProcess.pid).not.toBe(consumerProcess.pid);

    const task = identifier.parse(
      await host.bl(source, "work", { command: "create", title: "Publish process contract" }),
    );
    const imported = importedReference.parse(
      await host.bl(consumer, "reference-fixture", {
        command: "add",
        workspace: source,
        node: task.id,
      }),
    );
    await host.bl(source, "work", { command: "close", id: task.id });
    const closed = await eventually(
      readReference,
      (value) => value?.state === "closed" && value.reference.status === "current",
    );
    expect(closed?.reference.lakeId).toBe(imported.reference.lakeId);
    expect(closed?.reference.revision).toBeGreaterThan(imported.reference.revision);

    watch = Bun.spawn(
      [
        host.blBin,
        "--json",
        "--timeout",
        "12s",
        "--workspace",
        source,
        "events",
        "stream",
        "--event",
        "work.changed",
      ],
      { env: host.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    const reader = watch.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('"type":"ready"');
    reader.releaseLock();
    const terminal = new Response(watch.stderr).text();

    const resume = join(host.dir, "resume-source");
    const config = join(source, ".botlake/lake.ts");
    // Hold the replacement offline until the sibling observes the interruption.
    await Bun.write(
      config,
      `${await Bun.file(config).text()}\nwhile (!(await Bun.file(${JSON.stringify(resume)}).exists())) await Bun.sleep(20);\n`,
    );
    const restart = host.botlake(["lake", "restart", "--workspace", source]);
    await Promise.all([
      restart,
      (async () => {
        try {
          const stale = await eventually(
            readReference,
            (value) => value?.reference.status === "stale",
          );
          expect(stale?.state).toBe("closed");
          expect(JSON.parse(await terminal)).toMatchObject({ code: "lake-restarting" });
        } finally {
          await Bun.write(resume, "");
        }
      })(),
    ]);

    expect(await watch.exited).not.toBe(0);
    expect(
      lakeStatus.parse(await host.botlake(["lake", "status", "--workspace", source])).pid,
    ).not.toBe(sourceProcess.pid);
    expect(await host.botlake(["lake", "status", "--workspace", consumer])).toMatchObject({
      pid: consumerProcess.pid,
      ready: true,
    });
    const refetched = await eventually(
      readReference,
      (value) => value?.reference.status === "current",
    );
    expect(refetched).toMatchObject({
      id: imported.id,
      state: "closed",
      reference: { lakeId: imported.reference.lakeId },
    });
    await host.bl(source, "work", {
      command: "reopen",
      id: task.id,
      reason: "Continue source publication",
    });
    await host.bl(source, "work", {
      command: "update",
      id: task.id,
      title: "Published process contract",
    });
    const refreshed = await eventually(
      readReference,
      (value) =>
        value?.title === "Published process contract" && value.reference.status === "current",
    );
    expect(refreshed?.reference.lakeId).toBe(imported.reference.lakeId);
  } finally {
    watch?.kill();
    await host.close();
  }
}, 60_000);

test("a replacement database at the same route cannot retarget a retained reference", async () => {
  const host = await system();
  try {
    const source = await referenceBoard(host, "replaceable-owner");
    const consumer = await referenceBoard(host, "replacement-consumer");
    for (const workspace of [source, consumer])
      await host.botlake(["lake", "start", "--workspace", workspace]);
    const task = identifier.parse(
      await host.bl(source, "work", { command: "create", title: "Original owner" }),
    );
    const imported = importedReference.parse(
      await host.bl(consumer, "reference-fixture", {
        command: "add",
        workspace: source,
        node: task.id,
      }),
    );

    await host.botlake(["lake", "stop", "--workspace", source]);
    await rename(join(source, ".botlake/world.db"), join(source, ".botlake/original-world.db"));
    await host.botlake(["lake", "start", "--workspace", source]);

    const status = await eventually(
      () =>
        host
          .bl(consumer, "reference-fixture", { command: "status" })
          .then((value) => referenceStatus.parse(value).sources[0]),
      (value) => value?.state === "offline" && value.error?.code === "reference-owner-changed",
    );
    expect(status?.lakeId).toBe(imported.reference.lakeId);
    const retained = z
      .object({ nodes: z.array(importedReference) })
      .parse(await host.bl(consumer, "reference-fixture", { command: "list" })).nodes[0];
    expect(retained).toMatchObject({
      id: imported.id,
      state: "active",
      reference: {
        lakeId: imported.reference.lakeId,
        nodeId: task.id,
        status: "stale",
      },
    });
  } finally {
    await host.close();
  }
}, 60_000);
