import { test, expect } from "bun:test";
import { mkdtemp, realpath, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dependencyAttributes, ManualClock, Runtime, q } from "@botlake/core";
import { batteries } from "@botlake/extension-batteries";
import { identity } from "@botlake/extension-identity";
import { work } from "@botlake/extension-work";
import { z } from "zod";

import { rejected } from "./assert.ts";
import { system } from "./fixtures/system.ts";

type Host = Awaited<ReturnType<typeof system>>;

const identifier = z.object({ id: z.string() });
const reference = z.object({
  lakeId: z.uuid(),
  workspace: z.string(),
  nodeId: z.string(),
  revision: z.number(),
  observedAt: z.number(),
  status: z.enum(["current", "stale", "missing"]),
  kind: z.string().nullable(),
});
const acknowledgement = z.strictObject({ id: z.string(), state: z.string(), reference });
const observedNode = z.object({
  id: z.string(),
  title: z.string(),
  state: z.string(),
  attributes: z.record(z.string(), z.json()),
  revision: z.number(),
  reference,
});
const summary = acknowledgement.extend({ title: z.string() });
const referencePage = z.object({
  nodes: z.array(summary),
  total: z.number(),
  nextOffset: z.number().nullable(),
});
const sourceInfo = z.object({
  lakeId: z.uuid(),
  workspace: z.string(),
  projections: z.array(z.string()),
});
const errorResponse = z.object({ type: z.literal("error"), code: z.string(), message: z.string() });
const workDetail = z.object({ ready: z.boolean() });

test("packaged references keep source facts read-only and gate Work through disconnect, reconnect and source deletion", async () => {
  const host = await system();
  let stream: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const owner = await board(host, "owner");
    const consumer = await board(host, "consumer");
    await host.botlake(["lake", "start", "--workspace", owner]);
    await host.botlake(["lake", "start", "--workspace", consumer]);
    const ownerInfo = sourceInfo.parse(await host.bl(owner, "reference", { command: "source" }));
    const remote = identifier.parse(
      await host.bl(owner, "work", {
        command: "create",
        title: "Publish API contract",
        description: "Source-only implementation brief",
      }),
    );
    const imported = acknowledgement.parse(
      await host.bl(consumer, "reference", {
        command: "add",
        workspace: owner,
        node: remote.id,
      }),
    );
    expect(imported.reference).toMatchObject({
      lakeId: ownerInfo.lakeId,
      workspace: owner,
      nodeId: remote.id,
      kind: "work/task",
      status: "current",
    });
    expect(
      acknowledgement.parse(
        await host.bl(consumer, "reference", {
          command: "add",
          workspace: owner,
          node: remote.id,
        }),
      ).id,
    ).toBe(imported.id);
    const local = identifier.parse(
      await host.bl(consumer, "work", {
        command: "create",
        title: "Consume API contract",
        prerequisites: [imported.id],
      }),
    );
    expect(
      workDetail.parse(await host.bl(consumer, "work", { command: "show", id: local.id })).ready,
    ).toBe(false);
    expect((await failure(host, consumer, "work", { command: "claim", id: local.id })).code).toBe(
      "waiting",
    );
    for (const input of [
      { command: "update", id: imported.id, state: "closed" },
      { command: "set-attributes", id: imported.id, attributes: { "agent/run": true } },
    ])
      expect((await failure(host, consumer, "node", input)).code).toBe("reference-read-only");
    const replacement = identifier.parse(
      await host.bl(consumer, "node", { command: "add", title: "Local replacement" }),
    );
    expect(
      (await failure(host, consumer, "node", { command: "burn", ids: [imported.id] })).code,
    ).toBe("reference-read-only");
    expect(
      (
        await failure(host, consumer, "batch", {
          refs: { imported: imported.id },
          burn: ["imported"],
        })
      ).code,
    ).toBe("reference-read-only");
    expect(
      (
        await failure(host, consumer, "node", {
          command: "supersede",
          id: imported.id,
          replacement: replacement.id,
        })
      ).code,
    ).toBe("reference-read-only");
    expect(
      (
        await failure(host, consumer, "node", {
          command: "supersede",
          id: replacement.id,
          replacement: imported.id,
        })
      ).code,
    ).toBe("reference-read-only");
    expect(
      (
        await failure(host, consumer, "batch", {
          refs: { observed: imported.id },
          nodes: [{ ref: "observed", title: "Forged" }],
        })
      ).code,
    ).toBe("reference-read-only");
    const note = identifier.parse(
      await host.bl(consumer, "node", {
        command: "note",
        id: imported.id,
        text: "Local coordination evidence",
      }),
    );
    expect(
      z
        .object({ reference: z.null() })
        .parse(await host.bl(consumer, "node", { command: "show", id: note.id })).reference,
    ).toBeNull();
    expect(
      observedNode.parse(await host.bl(consumer, "node", { command: "show", id: imported.id }))
        .attributes,
    ).toEqual({});

    stream = Bun.spawn(
      [
        host.blBin,
        "--workspace",
        consumer,
        "--timeout",
        "30s",
        "events",
        "stream",
        "--event",
        "work.changed",
      ],
      { env: host.env, stdout: "pipe", stderr: "pipe" },
    );
    if (stream.stdout === undefined || stream.stdout === null || typeof stream.stdout === "number")
      throw new Error("Expected Work stream stdout");
    const events = jsonLines(stream.stdout)[Symbol.asyncIterator]();
    expect((await events.next()).value).toMatchObject({ type: "ready", events: ["work.changed"] });
    await host.bl(owner, "work", { command: "close", id: remote.id });
    await untilObserved(host, consumer, imported.id, "current", "closed", events);
    expect(
      workDetail.parse(await host.bl(consumer, "work", { command: "show", id: local.id })).ready,
    ).toBe(true);
    const graph = z
      .object({ nodes: z.array(z.object({ id: z.string(), reference: reference.optional() })) })
      .parse(
        await host.bl(consumer, "work", {
          command: "graph",
          id: local.id,
          state: "all",
          lean: true,
        }),
      );
    expect(graph.nodes.find((node) => node.id === imported.id)?.reference?.lakeId).toBe(
      ownerInfo.lakeId,
    );

    await host.botlake(["lake", "stop", "--workspace", owner]);
    await untilObserved(host, consumer, imported.id, "stale", "closed", events);
    expect(
      workDetail.parse(await host.bl(consumer, "work", { command: "show", id: local.id })).ready,
    ).toBe(false);
    expect((await failure(host, consumer, "work", { command: "claim", id: local.id })).code).toBe(
      "waiting",
    );
    await host.botlake(["lake", "start", "--workspace", owner]);
    await untilObserved(host, consumer, imported.id, "current", "closed", events);
    expect(sourceInfo.parse(await host.bl(owner, "reference", { command: "source" })).lakeId).toBe(
      ownerInfo.lakeId,
    );
    expect(
      workDetail.parse(await host.bl(consumer, "work", { command: "show", id: local.id })).ready,
    ).toBe(true);

    const artifact = identifier.parse(
      await host.bl(owner, "node", {
        command: "add",
        title: "Ephemeral source artifact",
        state: "closed",
      }),
    );
    const generic = acknowledgement.parse(
      await host.bl(consumer, "reference", { command: "add", workspace: owner, node: artifact.id }),
    );
    expect(generic.reference.kind).toBeNull();
    expect(
      (
        await failure(host, consumer, "work", {
          command: "link",
          from: local.id,
          to: generic.id,
          relation: "depends-on",
        })
      ).code,
    ).toBe("work-links");
    expect(
      (
        await failure(host, consumer, "edge", {
          command: "add",
          from: local.id,
          to: generic.id,
          relation: "depends-on",
        })
      ).code,
    ).toBe("work-links");
    await host.bl(consumer, "work", {
      command: "link",
      from: local.id,
      to: generic.id,
      relation: "references",
    });
    await host.bl(owner, "node", { command: "burn", ids: [artifact.id] });
    const missing = acknowledgement.parse(
      await host.bl(consumer, "reference", { command: "refresh", id: generic.id }),
    );
    expect(missing.reference).toMatchObject({
      lakeId: ownerInfo.lakeId,
      nodeId: artifact.id,
      status: "missing",
    });
    expect(
      observedNode.parse(await host.bl(consumer, "node", { command: "show", id: generic.id }))
        .title,
    ).toBe("Ephemeral source artifact");
    expect(await host.bl(consumer, "reference", { command: "forget", id: generic.id })).toEqual({
      id: generic.id,
      forgotten: true,
    });
    expect((await failure(host, consumer, "node", { command: "show", id: generic.id })).code).toBe(
      "not-found",
    );
    expect(
      z
        .object({ item: z.object({ state: z.string() }) })
        .parse(await host.bl(owner, "work", { command: "show", id: remote.id })).item.state,
    ).toBe("closed");
  } finally {
    stream?.kill();
    if (stream !== undefined) await stream.exited;
    await host.close();
  }
}, 60000);

test("packaged reference pages exclude source payloads and durable owners survive relocation without accepting a replacement database", async () => {
  const host = await system();
  try {
    const owner = await board(host, "page-owner");
    const other = await board(host, "other-owner");
    const consumer = await board(host, "page-consumer");
    for (const workspace of [owner, other, consumer])
      await host.botlake(["lake", "start", "--workspace", workspace]);
    const ownerInfo = sourceInfo.parse(await host.bl(owner, "reference", { command: "source" }));
    const otherInfo = sourceInfo.parse(await host.bl(other, "reference", { command: "source" }));
    expect(otherInfo.lakeId).not.toBe(ownerInfo.lakeId);
    const longPrompt = "source-only-private-instructions-".repeat(2000);
    const imported: z.output<typeof acknowledgement>[] = [];
    const sourceIds: string[] = [];
    for (let index = 0; index < 45; index++) {
      const node = identifier.parse(
        await host.bl(owner, "node", {
          command: "add",
          title: `Source ${index}`,
          attributes: index === 0 ? { "agent/prompt": longPrompt } : {},
        }),
      );
      sourceIds.push(node.id);
      imported.push(
        acknowledgement.parse(
          await host.bl(consumer, "reference", { command: "add", workspace: owner, node: node.id }),
        ),
      );
    }
    const first = imported[0];
    const second = imported[1];
    const firstSource = sourceIds[0];
    if (first === undefined || second === undefined || firstSource === undefined)
      throw new Error("Expected seeded source references");
    const foreign = identifier.parse(
      await host.bl(other, "node", { command: "add", title: "Other owner" }),
    );
    await host.bl(consumer, "reference", { command: "add", workspace: other, node: foreign.id });
    expect(
      (
        await failure(host, consumer, "reference", {
          command: "add",
          workspace: other,
          node: firstSource,
        })
      ).code,
    ).toBe("reference-missing");
    const defaultPageRaw = await host.bl(consumer, "reference", { command: "list" });
    const defaultPage = referencePage.parse(defaultPageRaw);
    expect(defaultPage.nodes).toHaveLength(20);
    expect(defaultPage.total).toBe(46);
    expect(defaultPage.nextOffset).toBe(20);
    expect(JSON.stringify(defaultPageRaw)).not.toContain(longPrompt);
    expect(JSON.stringify(defaultPageRaw)).not.toContain("attributes");
    expect(Buffer.byteLength(JSON.stringify(defaultPageRaw))).toBeLessThan(
      Buffer.byteLength(longPrompt),
    );
    const found = new Set<string>();
    let offset: number | null = 0;
    while (offset !== null) {
      const page = referencePage.parse(
        await host.bl(consumer, "reference", {
          command: "list",
          lakeId: ownerInfo.lakeId,
          limit: 17,
          offset,
        }),
      );
      expect(page.total).toBe(45);
      for (const node of page.nodes) {
        expect(node.reference.lakeId).toBe(ownerInfo.lakeId);
        found.add(node.id);
      }
      offset = page.nextOffset;
    }
    expect(found.size).toBe(45);
    expect(
      referencePage.parse(
        await host.bl(consumer, "reference", {
          command: "list",
          lakeId: ownerInfo.lakeId,
          offset: 1000,
        }),
      ),
    ).toMatchObject({ nodes: [], total: 45, nextOffset: null });
    const snapshot = await host.bl(owner, "reference", { command: "snapshot", ids: [firstSource] });
    expect(JSON.stringify(snapshot)).not.toContain(longPrompt);
    expect(JSON.stringify(snapshot)).not.toContain("attributes");
    expect(
      await host.bl(consumer, "reference", { command: "snapshot", ids: [first.id] }),
    ).toMatchObject({ nodes: [], missing: [first.id] });
    const status = z
      .object({
        sources: z.array(z.object({ lakeId: z.uuid(), state: z.string() })),
        total: z.number(),
        nextOffset: z.number().nullable(),
      })
      .parse(
        await host.bl(consumer, "reference", {
          command: "status",
          lakeId: ownerInfo.lakeId,
          limit: 1,
        }),
      );
    expect(status).toMatchObject({
      sources: [{ lakeId: ownerInfo.lakeId, state: "live" }],
      total: 1,
      nextOffset: null,
    });

    await host.botlake(["lake", "stop", "--workspace", owner]);
    const relocated = join(host.dir, "relocated-owner");
    await rename(owner, relocated);
    const newRoute = await realpath(relocated);
    await host.botlake(["lake", "start", "--workspace", newRoute]);
    expect(
      sourceInfo.parse(await host.bl(newRoute, "reference", { command: "source" })).lakeId,
    ).toBe(ownerInfo.lakeId);
    const moved = acknowledgement.parse(
      await host.bl(consumer, "reference", {
        command: "add",
        workspace: newRoute,
        node: firstSource,
      }),
    );
    expect(moved.id).toBe(first.id);
    expect(moved.reference.workspace).toBe(newRoute);
    expect(
      acknowledgement.parse(
        await host.bl(consumer, "reference", { command: "refresh", id: second.id }),
      ).reference.workspace,
    ).toBe(newRoute);
    expect(
      referencePage.parse(
        await host.bl(consumer, "reference", { command: "list", lakeId: ownerInfo.lakeId }),
      ).total,
    ).toBe(45);

    await host.botlake(["lake", "stop", "--workspace", newRoute]);
    for (const suffix of ["", "-wal", "-shm"])
      await rm(join(newRoute, `.botlake/world.db${suffix}`), { force: true });
    await host.botlake(["lake", "start", "--workspace", newRoute]);
    const replacement = sourceInfo.parse(
      await host.bl(newRoute, "reference", { command: "source" }),
    );
    expect(replacement.lakeId).not.toBe(ownerInfo.lakeId);
    expect(
      (await failure(host, consumer, "reference", { command: "refresh", id: first.id })).code,
    ).toBe("reference-owner-changed");
    const retained = observedNode.parse(
      await host.bl(consumer, "node", { command: "show", id: first.id }),
    );
    expect(retained.reference).toMatchObject({
      lakeId: ownerInfo.lakeId,
      nodeId: firstSource,
      status: "stale",
    });
    expect(retained.title).toBe("Source 0");
  } finally {
    await host.close();
  }
}, 60000);

test("reference package imports stay inert, selection stays domain-independent and agent admission rejects remote targets", async () => {
  const host = await system();
  try {
    const bare = await host.workspace("installed-only", []);
    const importScript = join(bare, "imports.ts");
    await Bun.write(
      importScript,
      `import { Runtime } from "@botlake/core";
import { references } from "@botlake/extension-references";
import { workReferenceProjections } from "@botlake/extension-work";
const selected = references({ projections: workReferenceProjections });
const runtime = new Runtime({ database: ":memory:" });
await runtime.start([]);
console.log(JSON.stringify({ extension: selected.name, operations: runtime.discovery().map((op) => op.name), nodes: runtime.graph.all().length }));
await runtime.stop();`,
    );
    const child = Bun.spawn(["bun", importScript], {
      cwd: bare,
      env: host.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, output, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(JSON.parse(output)).toEqual({
      extension: "references",
      operations: ["bins", "events"],
      nodes: 0,
    });
    await host.botlake(["lake", "start", "--workspace", bare]);
    expect((await failure(host, bare, "reference", { command: "list" })).code).toBe("not-found");

    const selected = await host.workspace("references-only", ["@botlake/extension-references"]);
    await host.botlake(["lake", "start", "--workspace", selected]);
    expect(
      sourceInfo.parse(await host.bl(selected, "reference", { command: "source" })).projections,
    ).toEqual([]);
    const selectedCatalog = z
      .array(z.object({ name: z.string() }))
      .parse(await host.bl(selected, "help", {}))
      .map((operation) => operation.name);
    expect(selectedCatalog).toEqual(["bins", "events", "reference"]);

    const owner = await host.workspace("generic-owner", [
      "@botlake/extension-batteries",
      "@botlake/extension-references",
    ]);
    const agentBoard = await host.workspace("agent-board", [
      "@botlake/extension-batteries",
      "@botlake/extension-identity",
      "@botlake/extension-flags",
      "@botlake/extension-agents",
      "@botlake/extension-references",
    ]);
    await host.botlake(["lake", "start", "--workspace", owner]);
    await host.botlake(["lake", "start", "--workspace", agentBoard]);
    const remote = identifier.parse(
      await host.bl(owner, "node", { command: "add", title: "A remote active record" }),
    );
    const imported = acknowledgement.parse(
      await host.bl(agentBoard, "reference", { command: "add", workspace: owner, node: remote.id }),
    );
    expect(
      (
        await failure(host, agentBoard, "agent", {
          command: "start",
          seat: "not-configured",
          cwd: agentBoard,
          target: imported.id,
          prompt: "Must never launch",
        })
      ).code,
    ).toBe("reference-target");
    expect(await host.bl(agentBoard, "agent", { command: "list" })).toMatchObject({
      runs: [],
      total: 0,
      nextOffset: null,
    });
  } finally {
    await host.close();
  }
}, 60000);

test("opening an existing lake invalidates retained observations even without selecting synchronization", async () => {
  const directory = await mkdtemp(join(tmpdir(), "botlake-reference-reopen-"));
  const clock = new ManualClock();
  const remote = new Runtime({ database: join(directory, "remote.db"), clock });
  const database = join(directory, "local.db");
  let local = new Runtime({ database, clock });
  try {
    await remote.start([identity(), work()]);
    await local.start([identity(), work()]);
    const prerequisite = identifier.parse(
      await remote.invoke("work", {
        command: "create",
        title: "Remote prerequisite",
        by: "tester",
      }),
    );
    await remote.invoke("work", { command: "close", id: prerequisite.id, by: "tester" });
    const snapshot = remote.graph.snapshots([prerequisite.id])[0];
    if (snapshot === undefined) throw new Error("Expected authoritative prerequisite snapshot");
    const { id: nodeId, ...facts } = snapshot;
    const imported = local.graph.observeReference(
      { lakeId: remote.graph.lakeId, workspace: "/remote", nodeId },
      { ...facts, kind: "work/task" },
    );
    const task = identifier.parse(
      await local.invoke("work", {
        command: "create",
        title: "Retained local work",
        prerequisites: [imported.id],
        by: "tester",
      }),
    );
    expect(
      workDetail.parse(await local.invoke("work", { command: "show", id: task.id })).ready,
    ).toBe(true);
    const observedAt = imported.reference?.observedAt;
    const lakeId = local.graph.lakeId;
    await local.stop();
    local = new Runtime({ database, clock });
    await local.start([identity(), work()]);
    const retained = local.graph.show(imported.id);
    expect(local.graph.lakeId).toBe(lakeId);
    expect(retained.reference).toMatchObject({ status: "stale", observedAt });
    expect(retained.revision).toBeGreaterThan(imported.revision);
    expect(
      workDetail.parse(await local.invoke("work", { command: "show", id: task.id })).ready,
    ).toBe(false);
  } finally {
    await local.stop();
    await remote.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("generic readiness honors declared reference kinds while leaving local and unconstrained dependencies unchanged", async () => {
  const directory = await mkdtemp(join(tmpdir(), "botlake-reference-kinds-"));
  const owner = new Runtime({ database: join(directory, "owner.db") });
  const local = new Runtime({ database: join(directory, "local.db") });
  try {
    await owner.start([batteries()]);
    await local.start([batteries()]);
    const remote = identifier.parse(
      await owner.invoke("node", { command: "add", title: "Remote prerequisite", state: "closed" }),
    );
    const facts = owner.graph.snapshots([remote.id])[0];
    if (facts === undefined) throw new Error("Expected authoritative prerequisite");
    const { id: nodeId, ...snapshot } = facts;
    const source = { lakeId: owner.graph.lakeId, workspace: "/owner", nodeId };
    const imported = local.graph.observeReference(source, { ...snapshot, kind: "custom/ready" });
    const constrained = identifier.parse(
      await local.invoke("node", { command: "add", title: "Constrained remote dependency" }),
    );
    const unconstrained = identifier.parse(
      await local.invoke("node", { command: "add", title: "Generic remote dependency" }),
    );
    const locallyDependent = identifier.parse(
      await local.invoke("node", { command: "add", title: "Local dependency" }),
    );
    const localPrerequisite = identifier.parse(
      await local.invoke("node", {
        command: "add",
        title: "Local closed prerequisite",
        state: "closed",
      }),
    );
    const kindConstraint = { [dependencyAttributes.referenceKinds]: ["custom/ready"] };
    await local.invoke("edge", {
      command: "add",
      from: constrained.id,
      to: imported.id,
      relation: "depends-on",
      attributes: kindConstraint,
    });
    await local.invoke("edge", {
      command: "add",
      from: unconstrained.id,
      to: imported.id,
      relation: "depends-on",
    });
    await local.invoke("edge", {
      command: "add",
      from: locallyDependent.id,
      to: localPrerequisite.id,
      relation: "depends-on",
      attributes: kindConstraint,
    });
    const ready = async () =>
      z
        .object({ nodes: z.array(identifier) })
        .parse(
          await local.invoke("node", {
            command: "ready",
            where: q.inArray("id", [constrained.id, unconstrained.id, locallyDependent.id]),
          }),
        )
        .nodes.map((node) => node.id)
        .toSorted();
    expect(await ready()).toEqual(
      [constrained.id, unconstrained.id, locallyDependent.id].toSorted(),
    );
    for (const invalid of [[], [""], ["custom/ready", "custom/ready"], "custom/ready", null, [1]]) {
      const error = await rejected(
        local.invoke("edge", {
          command: "add",
          from: constrained.id,
          to: imported.id,
          relation: "depends-on",
          attributes: { [dependencyAttributes.referenceKinds]: invalid },
        }),
      );
      expect(error).toMatchObject({ code: "dependency-reference-kinds" });
    }
    local.graph.observeReference(source, { ...snapshot, kind: null });
    expect(await ready()).toEqual([unconstrained.id, locallyDependent.id].toSorted());
    local.graph.observeReference(source, { ...snapshot, kind: "custom/other" });
    expect(await ready()).toEqual([unconstrained.id, locallyDependent.id].toSorted());
    await local.invoke("edge", {
      command: "add",
      from: constrained.id,
      to: imported.id,
      relation: "depends-on",
      attributes: { [dependencyAttributes.referenceKinds]: ["custom/ready", "custom/other"] },
    });
    expect(await ready()).toEqual(
      [constrained.id, unconstrained.id, locallyDependent.id].toSorted(),
    );
    local.graph.invalidateReferences({ lakeId: owner.graph.lakeId });
    expect(await ready()).toEqual([locallyDependent.id]);
    local.graph.observeReference(source, { ...snapshot, kind: "custom/other" });
    const replacement = identifier.parse(
      await owner.invoke("node", { command: "add", title: "Replacement source" }),
    );
    await owner.invoke("node", {
      command: "supersede",
      id: remote.id,
      replacement: replacement.id,
    });
    const replaced = owner.graph.snapshots([remote.id])[0];
    if (replaced === undefined) throw new Error("Expected retained replaced source");
    local.graph.observeReference(source, {
      title: replaced.title,
      state: replaced.state,
      revision: replaced.revision,
      kind: "custom/other",
    });
    expect(await ready()).toEqual([locallyDependent.id]);
  } finally {
    await local.stop();
    await owner.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

// -- Private helpers --

async function board(host: Host, name: string): Promise<string> {
  const workspace = await host.workspace(name, [
    "@botlake/extension-batteries",
    "@botlake/extension-identity",
    "@botlake/extension-work",
    "./references.ts",
  ]);
  await Bun.write(
    join(workspace, "references.ts"),
    `import { references } from "@botlake/extension-references";
import { workReferenceProjections } from "@botlake/extension-work";
export default references({ projections: workReferenceProjections });`,
  );
  return realpath(workspace);
}

async function failure(host: Host, workspace: string, operation: string, input: unknown) {
  const output = await host.cli(
    ["--json", "--workspace", workspace, "--input", JSON.stringify(input), operation],
    false,
  );
  return errorResponse.parse(JSON.parse(z.string().parse(output)));
}

async function untilObserved(
  host: Host,
  workspace: string,
  id: string,
  status: z.output<typeof reference>["status"],
  state: string,
  events: AsyncIterator<unknown>,
): Promise<void> {
  for (;;) {
    const node = observedNode.parse(await host.bl(workspace, "node", { command: "show", id }));
    if (node.reference.status === status && node.state === state) return;
    const next = await events.next();
    if (next.done === true) throw new Error(`Work stream ended before ${status}/${state}`);
  }
}

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
