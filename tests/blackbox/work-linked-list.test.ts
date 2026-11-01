import { test, expect } from "bun:test";

import { z } from "zod";

import { referenceBoard } from "./fixtures/references.ts";
import { system } from "./fixtures/system.ts";

const identifier = z.object({ id: z.string() });
const pageSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      kind: z.enum(["task", "group", "reference"]),
      state: z.enum(["open", "closed"]),
      ready: z.boolean(),
      reference: z
        .object({
          workspace: z.string(),
          nodeId: z.string(),
          status: z.string(),
          kind: z.string().nullable(),
        })
        .optional(),
    }),
  ),
  total: z.number(),
  nextOffset: z.number().nullable(),
});

test("Work lists linked remote endpoints beside owned work, with local-only queues and honest pages", async () => {
  const host = await system();
  try {
    const source = await referenceBoard(host, "listed-owner");
    const consumer = await referenceBoard(host, "listed-consumer");
    for (const workspace of [source, consumer])
      await host.botlake(["lake", "start", "--workspace", workspace]);
    const privateBrief = "source-only-private-brief-".repeat(2500);
    const remote = identifier.parse(
      await host.bl(source, "work", {
        command: "create",
        title: "Publish remote contract",
        description: privateBrief,
      }),
    );
    const group = identifier.parse(
      await host.bl(source, "work", {
        command: "create",
        title: "Remote delivery context",
        kind: "group",
      }),
    );
    const unlinked = identifier.parse(
      await host.bl(source, "work", {
        command: "create",
        title: "Unlinked remote task",
      }),
    );
    const unlinkedImport = identifier.parse(
      await host.bl(consumer, "reference-fixture", {
        command: "add",
        workspace: source,
        node: unlinked.id,
      }),
    );
    const local = identifier.parse(
      await host.bl(consumer, "work", { command: "create", title: "Owned work" }),
    );
    const anchors = [];
    for (const title of ["Closed originating work", "Another closed connection"]) {
      const item = identifier.parse(await host.bl(consumer, "work", { command: "create", title }));
      await host.bl(consumer, "work", { command: "close", id: item.id });
      anchors.push(item.id);
    }
    const [first, second] = z.tuple([z.string(), z.string()]).parse(anchors);
    const link = async (from: string, to: string, relation: "references" | "depends-on") =>
      z.object({ to: z.string() }).parse(
        await host.bl(consumer, "work", {
          command: "link",
          from,
          to,
          toWorkspace: source,
          relation,
        }),
      ).to;
    const remoteId = await link(first, remote.id, "references");
    expect(await link(second, remote.id, "references")).toBe(remoteId);
    expect(await link(second, remote.id, "depends-on")).toBe(remoteId);
    const groupId = await link(first, group.id, "references");
    const list = async (options: Record<string, string | number> = {}) =>
      pageSchema.parse(await host.bl(consumer, "work", { command: "list", ...options }));
    const initial = await list();
    expect(initial.total).toBe(3);
    expect(initial.items.map((item) => item.id).toSorted()).toEqual(
      [local.id, remoteId, groupId].toSorted(),
    );
    expect(initial.items.some((item) => item.id === unlinkedImport.id)).toBe(false);
    expect(initial.items.find((item) => item.id === remoteId)).toMatchObject({
      kind: "reference",
      state: "open",
      ready: false,
      reference: { workspace: source, nodeId: remote.id, status: "current", kind: "work/task" },
    });
    const raw = await host.bl(consumer, "work", { command: "list" });
    expect(Buffer.byteLength(JSON.stringify(raw))).toBeLessThan(2000);
    expect(JSON.stringify(raw)).not.toContain(privateBrief);
    expect((await list({ kind: "task" })).items.map((item) => item.id).toSorted()).toEqual(
      [local.id, remoteId].toSorted(),
    );
    expect((await list({ kind: "group" })).items.map((item) => item.id)).toEqual([groupId]);
    expect((await list({ search: "remote contract" })).items.map((item) => item.id)).toEqual([
      remoteId,
    ]);
    expect((await list({ search: "source-only-private-brief" })).total).toBe(0);
    for (const view of ["ready", "available", "assigned", "waiting", "human"])
      expect(
        (await list({ view, assignee: "fixture" })).items.some((item) => item.kind === "reference"),
      ).toBe(false);
    expect((await list({ view: "available" })).items.map((item) => item.id)).toEqual([local.id]);
    expect((await list({ audience: "AFK" })).items.map((item) => item.id)).toEqual([local.id]);
    expect((await list({ origin: "planned" })).items.map((item) => item.id)).toEqual([local.id]);
    expect((await list({ assignee: "fixture" })).total).toBe(0);
    expect((await list({ parent: first })).total).toBe(0);
    const all = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const page = await list({ state: "all", limit: 2, offset });
      expect(page.total).toBe(5);
      all.push(...page.items.map((item) => item.id));
      offset = page.nextOffset;
    }
    expect(all).toHaveLength(5);
    expect(new Set(all).size).toBe(5);
    expect(await host.bl(consumer, "work", { command: "show", id: remoteId })).toMatchObject({
      id: remoteId,
      kind: "reference",
      reference: { workspace: source, nodeId: remote.id, status: "current" },
    });
    for (const command of ["claim", "close", "update"]) {
      const result = await host.cli(
        [
          "--json",
          "--workspace",
          consumer,
          "--input",
          JSON.stringify({
            command,
            id: remoteId,
            ...(command === "update" ? { title: "Must remain remote" } : {}),
          }),
          "work",
        ],
        false,
      );
      expect(JSON.parse(z.string().parse(result))).toMatchObject({ code: "reference-read-only" });
    }
    expect(await host.bl(source, "work", { command: "show", id: remote.id })).toMatchObject({
      item: { title: "Publish remote contract", state: "open" },
    });
    await host.bl(source, "work", { command: "close", id: remote.id });
    await host.bl(consumer, "reference-fixture", { command: "refresh", id: remoteId });
    expect((await list()).items.map((item) => item.id).toSorted()).toEqual(
      [local.id, groupId].toSorted(),
    );
    expect((await list({ state: "closed" })).items.some((item) => item.id === remoteId)).toBe(true);
    await host.botlake(["lake", "stop", "--workspace", source]);
    await host.botlake(["lake", "restart", "--workspace", consumer]);
    expect((await list()).items.find((item) => item.id === groupId)).toMatchObject({
      reference: { status: "stale", nodeId: group.id },
    });
    for (const [from, to, relation] of [
      [first, groupId, "references"],
      [first, remoteId, "references"],
      [second, remoteId, "references"],
      [second, remoteId, "depends-on"],
    ])
      await host.bl(consumer, "work", { command: "unlink", from, to, relation });
    expect((await list()).items.map((item) => item.id)).toEqual([local.id]);
    expect((await list({ state: "all" })).total).toBe(3);
    expect(await host.bl(consumer, "node", { command: "show", id: remoteId })).toMatchObject({
      reference: { nodeId: remote.id },
    });
  } finally {
    await host.close();
  }
}, 60000);
