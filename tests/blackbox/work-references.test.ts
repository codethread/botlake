import { test, expect } from "bun:test";
import { realpath, rm } from "node:fs/promises";
import { join } from "node:path";

import { dependencyAttributes } from "@botlake/core";
import { agentAttributes } from "@botlake/extension-agents";
import { z } from "zod";

import { system } from "./fixtures/system.ts";

type Host = Awaited<ReturnType<typeof system>>;

const identifier = z.object({ id: z.string() });
const owner = z.object({ lakeId: z.uuid() });
const address = z.object({ lakeId: z.uuid(), workspace: z.string(), nodeId: z.string() });
const observed = address.extend({ title: z.string(), state: z.enum(["open", "closed"]) });
const diagnosis = z.object({
  root: address,
  complete: z.boolean(),
  examined: z.object({ lakes: z.number(), nodes: z.number(), edges: z.number() }),
  cycles: z.array(z.object({ path: z.array(observed), members: z.array(observed) })),
  unavailable: z.array(z.object({ node: address, code: z.string(), reason: z.string() })),
  limits: z.array(z.enum(["lakes", "nodes", "edges"])),
});
const dependencyPage = z.strictObject({
  lakeId: z.uuid(),
  workspace: z.string(),
  node: z.strictObject({ id: z.string(), title: z.string(), state: z.enum(["open", "closed"]) }),
  prerequisites: z.strictObject({
    items: z.array(address.strict()),
    total: z.number(),
    nextOffset: z.number().nullable(),
  }),
});
const workProjectionModule = `import { references } from "@botlake/extension-references";
import { workReferenceProjections } from "@botlake/extension-work";
export default references({ projections: workReferenceProjections });`;

test("Work imports remote link endpoints, validates their source kind and unlinks by retained local ID during an outage", async () => {
  const host = await system();
  try {
    const source = await board(host, "link-source");
    const consumer = await board(host, "link-consumer");
    for (const workspace of [source, consumer])
      await host.botlake(["lake", "start", "--workspace", workspace]);
    const remote = identifier.parse(
      await host.bl(source, "work", { command: "create", title: "Publish contract" }),
    );
    const local = identifier.parse(
      await host.bl(consumer, "work", { command: "create", title: "Consume contract" }),
    );
    const unrelated = identifier.parse(
      await host.bl(source, "node", {
        command: "add",
        title: "Non-work artifact",
        state: "closed",
      }),
    );
    expect(
      await failureCode(host, consumer, "work", {
        command: "link",
        from: local.id,
        to: unrelated.id,
        toWorkspace: source,
        relation: "depends-on",
      }),
    ).toBe("reference-kind");
    const imported = z
      .object({ to: z.string(), linked: z.literal(true), reference: address })
      .parse(
        await host.bl(consumer, "work", {
          command: "link",
          from: local.id,
          to: remote.id,
          toWorkspace: source,
          relation: "depends-on",
        }),
      );
    expect(imported.to).not.toBe(remote.id);
    expect(imported.reference).toMatchObject({ workspace: source, nodeId: remote.id });
    expect(await host.bl(consumer, "work", { command: "show", id: local.id })).toMatchObject({
      ready: false,
      prerequisites: [{ id: imported.to, kind: "reference" }],
    });
    expect(
      await host.bl(consumer, "work", {
        command: "unlink",
        from: local.id,
        to: remote.id,
        toWorkspace: source,
        relation: "depends-on",
      }),
    ).toMatchObject({ to: imported.to, linked: false });
    expect(await host.bl(consumer, "work", { command: "show", id: local.id })).toMatchObject({
      ready: true,
    });
    expect(
      await host.bl(consumer, "work", {
        command: "link",
        from: local.id,
        to: remote.id,
        toWorkspace: source,
        relation: "depends-on",
      }),
    ).toMatchObject({ to: imported.to, linked: true });
    await host.botlake(["lake", "stop", "--workspace", source]);
    expect(
      await host.cli([
        "--workspace",
        consumer,
        "work",
        "unlink",
        local.id,
        imported.to,
        "--relation",
        "depends-on",
      ]),
    ).toMatchObject({ to: imported.to, linked: false });
    expect(await host.bl(consumer, "work", { command: "show", id: local.id })).toMatchObject({
      ready: true,
    });
    expect(await host.bl(consumer, "node", { command: "show", id: imported.to })).toMatchObject({
      reference: { nodeId: remote.id },
    });

    const localOnly = await host.workspace("local-only", [
      "@botlake/extension-identity",
      "@botlake/extension-work",
    ]);
    await host.botlake(["lake", "start", "--workspace", localOnly]);
    const unconfigured = identifier.parse(
      await host.bl(localOnly, "work", { command: "create", title: "Local work" }),
    );
    expect(
      await failureCode(host, localOnly, "work", {
        command: "link",
        from: unconfigured.id,
        to: remote.id,
        toWorkspace: source,
        relation: "depends-on",
      }),
    ).toBe("reference-library");
  } finally {
    await host.close();
  }
}, 60000);

test("packaged Work diagnoses live cross-lake cycles and reports bounded, offline and replaced-owner branches explicitly", async () => {
  const host = await system();
  try {
    const first = await board(host, "diagnostic-first");
    const second = await board(host, "diagnostic-second");
    await host.botlake(["lake", "start", "--workspace", first]);
    await host.botlake(["lake", "start", "--workspace", second]);
    const firstOwner = owner.parse(await host.bl(first, "references", { command: "source" }));
    const secondOwner = owner.parse(await host.bl(second, "references", { command: "source" }));
    const firstTask = identifier.parse(
      await host.bl(first, "work", { command: "create", title: "Implement API" }),
    );
    const secondTask = identifier.parse(
      await host.bl(second, "work", { command: "create", title: "Implement UI" }),
    );
    const observedSecond = z
      .object({ to: z.string(), reference: address })
      .parse(
        await host.cli([
          "--workspace",
          first,
          "work",
          "link",
          firstTask.id,
          secondTask.id,
          "--to-workspace",
          second,
          "--relation",
          "depends-on",
        ]),
      );
    expect(observedSecond.reference).toEqual({
      lakeId: secondOwner.lakeId,
      workspace: second,
      nodeId: secondTask.id,
    });
    await host.bl(second, "work", {
      command: "link",
      from: secondTask.id,
      to: firstTask.id,
      toWorkspace: first,
      relation: "depends-on",
    });

    const result = diagnosis.parse(
      await host.bl(first, "work", { command: "diagnose", id: firstTask.id }),
    );
    expect(result).toMatchObject({
      complete: true,
      examined: { lakes: 2, nodes: 2, edges: 2 },
      unavailable: [],
      limits: [],
    });
    expect(result.root).toEqual({
      lakeId: firstOwner.lakeId,
      workspace: first,
      nodeId: firstTask.id,
    });
    expect(result.cycles).toHaveLength(1);
    const cycle = result.cycles[0];
    if (cycle === undefined) throw new Error("Expected cross-lake cycle");
    expect(cycle.path).toHaveLength(3);
    expect(cycle.path[0]).toEqual(cycle.path.at(-1));
    expect(new Set(cycle.members.map((node) => `${node.lakeId}:${node.nodeId}`))).toEqual(
      new Set([`${firstOwner.lakeId}:${firstTask.id}`, `${secondOwner.lakeId}:${secondTask.id}`]),
    );
    for (const [workspace, task] of [
      [first, firstTask],
      [second, secondTask],
    ] as const)
      expect(await host.bl(workspace, "work", { command: "show", id: task.id })).toMatchObject({
        ready: false,
      });

    for (const [bounds, limit] of [
      [{ maxNodes: 1 }, "nodes"],
      [{ maxLakes: 1 }, "lakes"],
      [{ maxEdges: 1 }, "edges"],
    ] as const) {
      const partial = diagnosis.parse(
        await host.bl(first, "work", { command: "diagnose", id: firstTask.id, ...bounds }),
      );
      expect(partial.complete).toBe(false);
      expect(partial.cycles).toEqual([]);
      expect(partial.limits).toContain(limit);
    }

    await host.botlake(["lake", "stop", "--workspace", second]);
    const disconnected = diagnosis.parse(
      await host.bl(first, "work", { command: "diagnose", id: firstTask.id }),
    );
    expect(disconnected.complete).toBe(false);
    expect(disconnected.cycles).toEqual([]);
    expect(disconnected.unavailable).toHaveLength(1);
    expect(disconnected.unavailable[0]).toMatchObject({
      node: { lakeId: secondOwner.lakeId, workspace: second, nodeId: secondTask.id },
      code: "botlake",
    });
    expect(disconnected.unavailable[0]?.reason).toContain("unknown workspace");
    await host.botlake(["lake", "start", "--workspace", second]);
    await host.bl(first, "reference-fixture", { command: "refresh", id: observedSecond.to });
    expect(
      diagnosis.parse(await host.bl(first, "work", { command: "diagnose", id: firstTask.id }))
        .complete,
    ).toBe(true);

    await host.botlake(["lake", "stop", "--workspace", second]);
    for (const suffix of ["", "-wal", "-shm"])
      await rm(join(second, `.botlake/world.db${suffix}`), { force: true });
    await host.botlake(["lake", "start", "--workspace", second]);
    const replacement = owner.parse(await host.bl(second, "references", { command: "source" }));
    expect(replacement.lakeId).not.toBe(secondOwner.lakeId);
    const replaced = diagnosis.parse(
      await host.bl(first, "work", { command: "diagnose", id: firstTask.id }),
    );
    expect(replaced.complete).toBe(false);
    expect(replaced.cycles).toEqual([]);
    expect(replaced.unavailable[0]).toMatchObject({
      node: { lakeId: secondOwner.lakeId, nodeId: secondTask.id },
      code: "source-mismatch",
    });
    expect(replaced.unavailable[0]?.reason).toContain(replacement.lakeId);
  } finally {
    await host.close();
  }
}, 60000);

test("packaged Work prerequisite frontiers page a large fan-out without copying briefs and complete a bounded acyclic traversal", async () => {
  const host = await system();
  try {
    const workspace = await board(host, "diagnostic-pages");
    await host.botlake(["lake", "start", "--workspace", workspace]);
    const source = owner.parse(await host.bl(workspace, "references", { command: "source" }));
    const privateBrief = "private-brief-and-findings-".repeat(2500);
    const prerequisites: string[] = [];
    for (let index = 0; index < 105; index++) {
      const created = identifier.parse(
        await host.bl(workspace, "work", {
          command: "create",
          title: `Prerequisite ${index}`,
          ...(index === 0 ? { description: privateBrief, notes: privateBrief } : {}),
        }),
      );
      prerequisites.push(created.id);
    }
    const root = identifier.parse(
      await host.bl(workspace, "work", {
        command: "create",
        title: "Large fan-out",
        description: privateBrief,
        prerequisites,
      }),
    );
    const raw = await host.bl(workspace, "work", { command: "dependencies", id: root.id });
    const first = dependencyPage.parse(raw);
    expect(first).toMatchObject({
      lakeId: source.lakeId,
      workspace,
      node: { id: root.id, title: "Large fan-out", state: "open" },
      prerequisites: { total: 105, nextOffset: 20 },
    });
    expect(first.prerequisites.items).toHaveLength(20);
    expect(JSON.stringify(raw)).not.toContain("private-brief-and-findings-");
    expect(JSON.stringify(raw)).not.toContain("description");
    expect(JSON.stringify(raw)).not.toContain("notes");
    expect(JSON.stringify(raw)).not.toContain("attributes");
    expect(Buffer.byteLength(JSON.stringify(raw))).toBeLessThan(Buffer.byteLength(privateBrief));

    const found = new Set<string>();
    let offset: number | null = 0;
    while (offset !== null) {
      const page = dependencyPage.parse(
        await host.bl(workspace, "work", {
          command: "dependencies",
          id: root.id,
          limit: 17,
          offset,
        }),
      );
      expect(page.prerequisites.total).toBe(105);
      for (const item of page.prerequisites.items) {
        expect(item.lakeId).toBe(source.lakeId);
        expect(item.workspace).toBe(workspace);
        found.add(item.nodeId);
      }
      offset = page.prerequisites.nextOffset;
    }
    expect(found).toEqual(new Set(prerequisites));
    expect(
      dependencyPage.parse(
        await host.bl(workspace, "work", { command: "dependencies", id: root.id, offset: 1000 }),
      ).prerequisites,
    ).toEqual({ items: [], total: 105, nextOffset: null });
    expect(
      diagnosis.parse(
        await host.bl(workspace, "work", {
          command: "diagnose",
          id: root.id,
          maxLakes: 1,
          maxNodes: 106,
          maxEdges: 105,
        }),
      ),
    ).toMatchObject({
      complete: true,
      examined: { lakes: 1, nodes: 106, edges: 105 },
      cycles: [],
      unavailable: [],
      limits: [],
    });
  } finally {
    await host.close();
  }
}, 60000);

test("Work projection constraints keep generic readiness and queued agent admission aligned when source classification is removed and restored", async () => {
  const host = await system();
  try {
    const source = await board(host, "projection-owner");
    const consumer = await board(host, "projection-agent", ["./flags.ts", "./providers.ts"]);
    const marker = join(consumer, "launched.txt");
    const child = join(consumer, "worker.ts");
    await Bun.write(
      join(consumer, "flags.ts"),
      `import { agentFlags } from "@botlake/extension-agents";
import { configureFlags } from "@botlake/extension-flags";
export default configureFlags([[agentFlags.codex, true]]);`,
    );
    await Bun.write(
      child,
      `await Bun.write(${JSON.stringify(marker)}, "admitted");
console.log(JSON.stringify({type:"thread.started",thread_id:"projection-fixture-session"}));
console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"done"}}));
console.log(JSON.stringify({type:"turn.completed"}));`,
    );
    await Bun.write(
      join(consumer, "providers.ts"),
      `import { agents, provider } from "@botlake/extension-agents";
const base=provider("codex");
export default agents({providers:[{...base,prepare(){return {command:["bun",${JSON.stringify(child)}],stdin:"",env:{}};}}],aliases:{worker:{provider:"codex"}}});`,
    );
    await host.botlake(["lake", "start", "--workspace", source]);
    await host.botlake(["lake", "start", "--workspace", consumer]);
    const remote = identifier.parse(
      await host.bl(source, "work", { command: "create", title: "Completed source work" }),
    );
    await host.bl(source, "work", { command: "close", id: remote.id });
    const target = identifier.parse(
      await host.bl(consumer, "work", { command: "create", title: "Target task" }),
    );
    const imported = z
      .object({ to: z.string() })
      .transform(({ to }) => ({ id: to }))
      .parse(
        await host.bl(consumer, "work", {
          command: "link",
          from: target.id,
          to: remote.id,
          toWorkspace: source,
          relation: "depends-on",
        }),
      );
    const linked = identifier.parse(
      await host.bl(consumer, "work", { command: "create", title: "Explicit link" }),
    );
    for (const attributes of [
      {},
      { [dependencyAttributes.referenceKinds]: ["work/task"] },
      { [dependencyAttributes.referenceKinds]: ["work/task", "work/group", "agent/run"] },
    ])
      expect(
        await failureCode(host, consumer, "edge", {
          command: "add",
          from: linked.id,
          to: imported.id,
          relation: "depends-on",
          attributes,
        }),
      ).toBe("work-links");
    expect(
      await failureCode(host, consumer, "edge", {
        command: "add",
        from: linked.id,
        to: imported.id,
        relation: "depends-on",
        attributes: { [dependencyAttributes.referenceKinds]: "work/task" },
      }),
    ).toBe("dependency-reference-kinds");
    await host.bl(consumer, "edge", {
      command: "add",
      from: linked.id,
      to: imported.id,
      relation: "depends-on",
      attributes: { [dependencyAttributes.referenceKinds]: ["work/task", "work/group"] },
    });
    await host.bl(consumer, "work", {
      command: "unlink",
      from: linked.id,
      to: imported.id,
      relation: "depends-on",
    });
    await host.bl(consumer, "work", {
      command: "link",
      from: linked.id,
      to: imported.id,
      relation: "depends-on",
    });
    for (const id of [target.id, linked.id]) {
      const edges = z
        .object({ edges: z.array(z.object({ attributes: z.record(z.string(), z.json()) })) })
        .parse(
          await host.bl(consumer, "edge", {
            command: "list",
            id,
            relation: "depends-on",
            lean: false,
          }),
        );
      expect(edges.edges).toHaveLength(1);
      expect(edges.edges[0]?.attributes[dependencyAttributes.referenceKinds]).toEqual([
        "work/task",
        "work/group",
      ]);
    }
    const localPrerequisite = identifier.parse(
      await host.bl(consumer, "work", { command: "create", title: "Local prerequisite" }),
    );
    const localDependent = identifier.parse(
      await host.bl(consumer, "work", { command: "create", title: "Local dependent" }),
    );
    await host.bl(consumer, "edge", {
      command: "add",
      from: localDependent.id,
      to: localPrerequisite.id,
      relation: "depends-on",
    });

    await Bun.write(
      join(source, "references.ts"),
      `import { references } from "@botlake/extension-references"; export default references();`,
    );
    await host.botlake(["lake", "restart", "--workspace", source]);
    expect(
      await host.bl(consumer, "reference-fixture", { command: "refresh", id: imported.id }),
    ).toMatchObject({ state: "closed", reference: { kind: null, status: "current" } });
    expect(await host.bl(consumer, "work", { command: "show", id: target.id })).toMatchObject({
      ready: false,
    });
    const blocked = z
      .object({ nodes: z.array(identifier) })
      .parse(
        await host.bl(consumer, "node", { command: "ready", query: "work-items", limit: 100 }),
      );
    expect(blocked.nodes.some((node) => node.id === target.id)).toBe(false);
    const run = identifier.parse(
      await host.bl(consumer, "agent", {
        command: "start",
        seat: "worker",
        cwd: consumer,
        target: target.id,
        prompt: "Write the admission marker",
      }),
    );
    await host.bl(consumer, "agent", { command: "reconcile" });
    const pending = z
      .object({ attributes: z.record(z.string(), z.json()) })
      .parse(await host.bl(consumer, "agent", { command: "show", id: run.id }));
    expect(pending.attributes[agentAttributes.lifecycle]).toBe("pending");
    expect(pending.attributes[agentAttributes.attempt]).toBe(0);
    expect(await Bun.file(marker).exists()).toBe(false);

    await Bun.write(join(source, "references.ts"), workProjectionModule);
    await host.botlake(["lake", "restart", "--workspace", source]);
    expect(
      await host.bl(consumer, "reference-fixture", { command: "refresh", id: imported.id }),
    ).toMatchObject({ state: "closed", reference: { kind: "work/task", status: "current" } });
    expect(await host.bl(consumer, "work", { command: "show", id: target.id })).toMatchObject({
      ready: true,
    });
    const available = z
      .object({ nodes: z.array(identifier) })
      .parse(
        await host.bl(consumer, "node", { command: "ready", query: "work-items", limit: 100 }),
      );
    expect(available.nodes.some((node) => node.id === target.id)).toBe(true);
    await host.bl(consumer, "agent", { command: "reconcile" });
    expect(
      await host.bl(consumer, "await", {
        query: "agent-run-settled",
        params: { runId: run.id },
        minCount: 1,
        timeoutSecs: 10,
      }),
    ).toMatchObject({ reason: "satisfied" });
    const completed = z
      .object({ attributes: z.record(z.string(), z.json()) })
      .parse(await host.bl(consumer, "agent", { command: "show", id: run.id }));
    expect(completed.attributes[agentAttributes.lifecycle]).toBe("completed");
    expect(completed.attributes[agentAttributes.attempt]).toBe(1);
    expect(await Bun.file(marker).text()).toBe("admitted");
  } finally {
    await host.close();
  }
}, 60000);

// -- Private helpers --

async function board(host: Host, name: string, extra: string[] = []): Promise<string> {
  const workspace = await host.workspace(name, [
    "@botlake/extension-batteries",
    "@botlake/extension-identity",
    ...extra,
    "./work.ts",
    "./references.ts",
    "./reference-fixture.ts",
  ]);
  await Bun.write(join(workspace, "references.ts"), workProjectionModule);
  await Bun.write(
    join(workspace, "work.ts"),
    `import { work } from "@botlake/extension-work";
import references from "./references.ts";
export default work({references});`,
  );
  await Bun.write(
    join(workspace, "reference-fixture.ts"),
    `import {defineOp,jsonSchema} from "@botlake/core";
import {z} from "zod";
import references from "./references.ts";
export default {name:"reference-fixture",requires:[references.name],activate(ctx){
const refs=references.get(ctx);
ctx.register(defineOp({name:"reference-fixture",input:z.object({command:z.literal("refresh"),id:z.string()}),output:jsonSchema,
cli:{description:"Test-only library adapter"},async handler(input,_ctx,request){return jsonSchema.parse(await refs.refresh(input.id,request.signal));}}));}};`,
  );
  return realpath(workspace);
}

async function failureCode(
  host: Host,
  workspace: string,
  operation: string,
  input: unknown,
): Promise<string> {
  const output = await host.cli(
    ["--json", "--workspace", workspace, "--input", JSON.stringify(input), operation],
    false,
  );
  return z.object({ code: z.string() }).parse(JSON.parse(z.string().parse(output))).code;
}
