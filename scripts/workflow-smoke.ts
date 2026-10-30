// Durable black-box smoke through the real packaged CLI, authored definitions and disposable lakes.
/* oxlint-disable typescript/no-non-null-assertion -- parsed cardinality is asserted by the smoke schemas. */
import assert from "node:assert/strict";
import { join } from "node:path";

import { z } from "zod";

import { system } from "../tests/blackbox/fixtures/system.ts";
import { copyWorkflowExample } from "../tests/blackbox/fixtures/workflows.ts";

const identifier = z.object({ id: z.string() });
const attribution = z.object({ identity: z.string(), nodeIds: z.array(z.string()) });
const blockageSummary = z.object({
  id: z.string(),
  domain: z.string(),
  target: z.string(),
  reason: z.string(),
});
const blockageDetail = blockageSummary.extend({
  raisedBy: attribution,
  neededFrom: attribution.nullable(),
  raisedAt: z.string(),
  resolution: z.object({ text: z.string(), by: attribution, at: z.string() }).nullable(),
});
const taskSummary = z
  .object({
    id: z.string(),
    title: z.string(),
    status: z.enum(["ready", "blocked"]),
    assignee: attribution.nullable(),
    blockages: z.array(blockageSummary),
    blockers: z.array(z.object({ id: z.string(), title: z.string() })),
  })
  .loose();
const runView = z.object({
  run: z.object({
    id: z.string(),
    title: z.string(),
    status: z.enum(["active", "blocked", "complete"]),
    blockages: z.array(blockageSummary),
  }),
  tasks: z.array(taskSummary),
  history: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      choice: z.string(),
      assignee: attribution.nullable(),
    }),
  ),
});
const taskDetail = z.object({
  run: runView.shape.run,
  tasks: z
    .array(
      taskSummary.extend({
        status: z.enum(["ready", "blocked", "done"]),
        instructions: z.string(),
        choices: z.record(z.string(), z.object({ schema: z.unknown() })),
        context: z.record(z.string(), z.unknown()),
        stateNode: z.string(),
        visit: z.number(),
        result: z.object({ choice: z.string(), data: z.unknown() }).nullable(),
        completedBy: attribution.nullable(),
        assignments: z.array(
          z.object({ id: z.string(), assignee: attribution, claimedAt: z.string() }),
        ),
        blockageHistory: z.array(blockageDetail),
        bee: z.unknown().optional(),
      }),
    )
    .length(1),
});

const host = await system();
const evidence: string[] = [];
const payloadBytes: Record<string, number> = {};
function measure(name: string, value: unknown): void {
  payloadBytes[name] = new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

try {
  const selected = [
    "@botlake/extension-batteries",
    "@botlake/extension-identity",
    "@botlake/extension-workflow",
  ];
  const workspace = await host.workspace("workflow-smoke", selected);
  await copyWorkflowExample(workspace, "parallel");
  await copyWorkflowExample(workspace, "nested-machines");
  await host.botlake(["lake", "start", "--workspace", workspace]);

  const cli = (args: string[], ok = true) => host.cli(["--workspace", workspace, ...args], ok);
  const call = (op: string, input: unknown, ok = true) => host.bl(workspace, op, input, ok);
  const show = async (id: string) => runView.parse(await cli(["workflow", "show", id]));
  const detail = async (id: string) => taskDetail.parse(await cli(["workflow", "show", id]));
  const task = (view: z.infer<typeof runView>, title: string) =>
    z.string().parse(view.tasks.find((row) => row.title === title)?.id);
  const complete = (id: string, choice = "next", data: unknown = {}) =>
    cli(["workflow", "complete", id, choice, "--data", JSON.stringify(data)]);
  const deniedCli = async (args: string[], pattern: RegExp) => {
    assert.match(z.string().parse(await cli(args, false)), pattern);
  };
  const deniedCall = async (op: string, input: unknown, pattern: RegExp) => {
    assert.match(z.string().parse(await call(op, input, false)), pattern);
  };

  const catalog = z
    .array(z.object({ name: z.string(), source: z.string() }))
    .parse(await cli(["workflow", "catalog"]));
  assert.deepEqual(
    catalog.map(({ name }) => name),
    ["nested-machines", "parallel"],
  );
  for (const entry of catalog) assert.ok(await Bun.file(entry.source).exists());
  const contract = z
    .object({ input: z.object({ type: z.literal("object") }) })
    .parse(await cli(["workflow", "catalog", "parallel"]));
  assert.equal(contract.input.type, "object");
  const badInput = z
    .string()
    .parse(await cli(["workflow", "start", "parallel", "--input", "null"], false));
  assert.match(badInput, /validation/u);
  assert.match(badInput, /expected object/iu);
  assert.match(badInput, /workflow catalog parallel/u);
  const commands = z
    .array(z.object({ cli: z.object({ commands: z.record(z.string(), z.unknown()) }) }))
    .parse(await cli(["help", "workflow"]));
  assert.deepEqual(Object.keys(commands[0]!.cli.commands).toSorted(), [
    "block",
    "catalog",
    "claim",
    "complete",
    "show",
    "start",
    "unblock",
  ]);
  evidence.push("catalogue files, named input schema hint and seven-command discovery");

  const initialResponse = await cli(["workflow", "start", "parallel"]);
  measure("initialRun", initialResponse);
  const initial = runView.parse(initialResponse);
  assert.deepEqual(
    initial.tasks.map(({ title }) => title),
    ["Prepare change"],
  );
  assert.equal(initial.history.length, 0);
  assert.equal("instructions" in initial.tasks[0]!, false);
  assert.equal("context" in initial.tasks[0]!, false);
  assert.equal("choices" in initial.tasks[0]!, false);
  assert.equal("snapshot" in initial, false);
  const prepare = task(initial, "Prepare change");
  const prepareResponse = await cli(["workflow", "show", prepare]);
  measure("initialTaskDetail", prepareResponse);
  assert.equal(
    "commands" in
      z.object({ tasks: z.array(z.record(z.string(), z.unknown())) }).parse(prepareResponse)
        .tasks[0]!,
    false,
  );
  const prepareDetail = taskDetail.parse(prepareResponse);
  assert.equal(prepareDetail.tasks[0]!.stateNode, "parallel-work.prepare");
  assert.deepEqual(Object.keys(prepareDetail.tasks[0]!.choices), ["next"]);
  assert.match(prepareDetail.tasks[0]!.instructions, /Identify/u);

  const extra = identifier.parse(
    await cli(["add", "Record acceptance", "--attributes", '{"smoke":true}']),
  ).id;
  await cli(["edge", "add", prepare, extra, "parent-of"]);
  await cli(["edge", "add", prepare, extra, "depends-on"]);
  const blockedByGraph = await show(initial.run.id);
  assert.deepEqual(blockedByGraph.tasks[0]!.blockers, [{ id: extra, title: "Record acceptance" }]);
  assert.ok(
    z
      .array(z.object({ id: z.string() }))
      .parse(await cli(["ready"]))
      .some(({ id }) => id === extra),
  );
  await deniedCli(["workflow", "complete", prepare, "next"], /prerequisite|ready/iu);
  await cli(["update", extra, "--state", "closed"]);

  await cli(["workflow", "claim", prepare, "--owner", "owner-alpha"]);
  const claimed = await detail(prepare);
  assert.equal(claimed.tasks[0]!.assignee?.identity, "owner-alpha");
  assert.equal(claimed.tasks[0]!.assignments.length, 1);
  assert.equal(claimed.tasks[0]!.completedBy, null);
  const beforeSnapshot = await call("show", { id: initial.run.id });
  await complete(prepare);
  const branches = await show(initial.run.id);
  assert.deepEqual(branches.tasks.map(({ title }) => title).toSorted(), [
    "Implement API",
    "Write docs",
  ]);
  assert.equal(branches.history[0]!.assignee?.identity, "owner-alpha");
  const historical = await detail(prepare);
  assert.equal(historical.tasks[0]!.result?.choice, "next");
  assert.equal(historical.tasks[0]!.completedBy?.identity, process.env["BL_ACTOR"]);
  assert.equal(historical.tasks[0]!.assignments[0]!.assignee.identity, "owner-alpha");
  const afterSnapshot = z
    .object({ attributes: z.record(z.string(), z.unknown()) })
    .parse(await call("show", { id: initial.run.id }));
  assert.notEqual(
    z.object({ attributes: z.record(z.string(), z.unknown()) }).parse(beforeSnapshot).attributes[
      "workflow/snapshot"
    ],
    afterSnapshot.attributes["workflow/snapshot"],
  );
  await host.botlake(["lake", "restart", "--workspace", workspace]);
  assert.deepEqual(await show(initial.run.id), branches);
  evidence.push(
    "summary/detail disclosure, generic prerequisites, claims, completer and restart snapshot",
  );

  const api = task(branches, "Implement API");
  const docs = task(branches, "Write docs");
  await complete(api);
  const apiReview = await show(initial.run.id);
  const verifyApi = task(apiReview, "Verify API");
  assert.equal(task(apiReview, "Write docs"), docs);
  await complete(docs);
  const docsReview = await show(initial.run.id);
  await complete(task(docsReview, "Check docs"), "revise");
  const revision = await show(initial.run.id);
  const revisedDocs = task(revision, "Write docs");
  assert.notEqual(revisedDocs, docs);
  assert.equal((await detail(revisedDocs)).tasks[0]!.visit, 2);
  assert.equal(task(revision, "Verify API"), verifyApi);
  let latestDocs = revisedDocs;
  for (let index = 0; index < 10; index++) {
    await complete(latestDocs);
    await complete(task(await show(initial.run.id), "Check docs"), "revise");
    latestDocs = task(await show(initial.run.id), "Write docs");
  }
  const longHistory = await cli(["workflow", "show", initial.run.id]);
  assert.ok(runView.parse(longHistory).history.length > 20);
  measure("unpaginatedHistoryOverTwentySteps", longHistory);
  await complete(latestDocs);
  await complete(task(await show(initial.run.id), "Check docs"), "approved");
  await complete(verifyApi);
  await complete(task(await show(initial.run.id), "Hand off change"));
  assert.equal((await show(initial.run.id)).run.status, "complete");
  await deniedCall("update", { id: prepare, state: "active" }, /consumed|workflow/iu);
  evidence.push("parallel independence, fresh revision visits, history and consumed immutability");

  const nested = runView.parse(await cli(["workflow", "start", "nested-machines"]));
  assert.deepEqual(nested.tasks.map(({ title }) => title).toSorted(), [
    "Implement API",
    "Implement interface",
  ]);
  const nestedApi = task(nested, "Implement API");
  const extras: string[] = [];
  for (let index = 0; index < 23; index++) {
    const child = identifier.parse(await cli(["add", `Extra ${index}`])).id;
    await cli(["edge", "add", nestedApi, child, "parent-of"]);
    extras.push(child);
  }
  assert.equal((await show(nested.run.id)).tasks.length, 2);
  assert.equal(
    z.object({ nodes: z.array(z.unknown()) }).parse(await cli(["subgraph", nestedApi])).nodes
      .length,
    24,
  );
  const extraRefs = Object.fromEntries(extras.map((id, index) => [`extra-${index}`, id]));
  await cli([
    "batch",
    "--refs",
    JSON.stringify(extraRefs),
    "--nodes",
    JSON.stringify(extras.map((_, index) => ({ ref: `extra-${index}`, state: "closed" }))),
  ]);
  await complete(nestedApi);
  const nestedReview = await show(nested.run.id);
  assert.equal(task(nestedReview, "Implement interface"), task(nested, "Implement interface"));
  const reviewer = await detail(task(nestedReview, "Verify API"));
  assert.equal(z.object({ kind: z.string() }).parse(reviewer.tasks[0]!.bee).kind, "reviewer");
  await host.botlake(["lake", "restart", "--workspace", workspace]);
  await complete(task(await show(nested.run.id), "Verify API"));
  await complete(task(await show(nested.run.id), "Implement interface"));
  await complete(task(await show(nested.run.id), "Verify interface"));
  await complete(task(await show(nested.run.id), "Summarize both branches"));
  assert.equal((await show(nested.run.id)).run.status, "complete");
  evidence.push("nested actors, more than twenty descendants, batch closure and restart routing");

  await exerciseBlockages();
  await exerciseKanbanProtocolAlone();
  await exerciseTransformedFixture();
  await exerciseDefinitionHash();

  const help = z.array(z.object({ name: z.string() })).parse(await call("help", {}));
  assert.ok(!help.some(({ name }) => name === "kanban" || name === "agent"));
  evidence.push("identity is explicit, Workflow remains Kanban-independent and launches no actor");

  console.log(JSON.stringify({ ok: true, verified: evidence, payloadBytes }));

  async function exerciseBlockages(): Promise<void> {
    const cross = await host.workspace("workflow-cross-domain", [
      "@botlake/extension-batteries",
      "@botlake/extension-identity",
      "@botlake/extension-kanban",
      "@botlake/extension-workflow",
    ]);
    await copyWorkflowExample(cross, "parallel");
    await host.botlake(["lake", "start", "--workspace", cross]);
    const xcli = (args: string[], ok = true) => host.cli(["--workspace", cross, ...args], ok);
    const xcall = (op: string, input: unknown, ok = true) => host.bl(cross, op, input, ok);
    const card = identifier.parse(
      await xcli(["kanban", "add", "Blocked delivery", "--progression", "children"]),
    ).id;
    const run = runView.parse(await xcli(["workflow", "start", "parallel", "--parent", card]));
    const worker = task(run, "Prepare change");
    const first = blockageDetail.parse(
      await xcli([
        "workflow",
        "block",
        worker,
        "--reason",
        "Need API decision",
        "--needed-from",
        "architect",
      ]),
    );
    await xcli(["kanban", "claim", card, "--owner", "parent-owner", "--branch", "smoke"]);
    const second = blockageDetail.parse(
      await xcli(["workflow", "block", run.run.id, "--reason", "Release freeze"]),
    );
    const crossDomain = blockageDetail.parse(
      await xcli(["kanban", "block", card, "--reason", "Business approval"]),
    );
    assert.equal(
      taskDetail.parse(await xcli(["workflow", "show", worker])).tasks[0]!.blockages.length,
      3,
    );
    assert.equal(runView.parse(await xcli(["workflow", "show", run.run.id])).run.status, "blocked");
    assert.equal(
      z
        .object({ card: z.object({ attributes: z.record(z.string(), z.unknown()) }) })
        .parse(await xcli(["kanban", "card", card])).card.attributes["kanban/lane"],
      "blocked",
    );
    assert.equal(
      z
        .array(z.object({ id: z.string() }))
        .parse(await xcli(["ready"]))
        .some(({ id }) => id === worker),
      true,
    );
    await assert.rejects(xcli(["kanban", "unblock", first.id, "--resolution", "wrong"]));
    for (const record of [first, second])
      await xcli(["workflow", "unblock", record.id, "--resolution", "Resolved"]);
    assert.equal(
      taskDetail.parse(await xcli(["workflow", "show", worker])).tasks[0]!.blockages.length,
      1,
    );
    const resolved = blockageDetail.parse(
      await xcli(["kanban", "unblock", crossDomain.id, "--resolution", "Approved"]),
    );
    assert.equal(resolved.resolution?.text, "Approved");
    const restoredCard = z
      .object({ card: z.object({ attributes: z.record(z.string(), z.unknown()) }) })
      .parse(await xcli(["kanban", "card", card]));
    assert.equal(restoredCard.card.attributes["kanban/lane"], "claimed");
    for (const mutation of [
      ["update", { id: first.id, state: "closed" }],
      ["archive", { id: first.id, keys: ["work/reason"] }],
      ["burn", { ids: [first.id] }],
      ["supersede", { id: first.id, replacement: worker }],
      ["edge", { command: "remove", from: first.id, to: worker, relation: "blocks" }],
    ] as const)
      assert.match(
        z.string().parse(await xcall(mutation[0], mutation[1], false)),
        /blockage|immutable|Workflow/iu,
      );
    await xcli(["workflow", "claim", worker, "--owner", "cross-domain-owner"]);
    assert.equal(
      taskDetail.parse(await xcli(["workflow", "show", worker])).tasks[0]!.assignee?.identity,
      "cross-domain-owner",
    );
    await xcli(["workflow", "complete", worker, "next"]);
    await assert.rejects(xcli(["kanban", "update", card, "--lane", "in_review"]));
    evidence.push(
      "multiple inherited cross-domain blockages, individual resolution, readiness distinction and guards",
    );
  }

  async function exerciseKanbanProtocolAlone(): Promise<void> {
    const isolated = await host.workspace("kanban-protocol-only", [
      "@botlake/extension-batteries",
      "@botlake/extension-identity",
      "@botlake/extension-kanban",
    ]);
    await host.botlake(["lake", "start", "--workspace", isolated]);
    const invoke = (op: string, fields: object, ok = true) => host.bl(isolated, op, fields, ok);
    const parent = identifier.parse(
      await invoke("kanban", { command: "add", title: "Held scope", progression: "children" }),
    ).id;
    const middle = identifier.parse(await invoke("add", { title: "Ordinary group" })).id;
    const leaf = identifier.parse(await invoke("add", { title: "Ordinary leaf" })).id;
    const replacement = identifier.parse(await invoke("add", { title: "Replacement" })).id;
    await invoke("edge", { command: "add", from: parent, to: middle, relation: "parent-of" });
    await invoke("edge", { command: "add", from: middle, to: leaf, relation: "parent-of" });
    for (const ids of [[parent], [parent, middle, leaf]])
      assert.match(z.string().parse(await invoke("burn", { ids }, false)), /contained work/iu);
    const hold = blockageDetail.parse(
      await invoke("kanban", { command: "block", id: parent, reason: "Need business approval" }),
    );
    for (const [op, fields] of [
      ["burn", { ids: [middle] }],
      ["edge", { command: "remove", from: middle, to: leaf, relation: "parent-of" }],
      ["supersede", { id: leaf, replacement }],
      ["supersede", { id: parent, replacement }],
      ["kanban", { command: "update", id: parent, lane: "in_review" }],
      ["archive", { id: hold.id, keys: ["work/blockage"] }],
    ] as const)
      assert.match(z.string().parse(await invoke(op, fields, false)), /block|contained work/iu);
    await invoke("kanban", { command: "unblock", id: hold.id, resolution: "Approval received" });
    const free = identifier.parse(
      await invoke("kanban", { command: "add", title: "No impediment" }),
    ).id;
    assert.match(
      z
        .string()
        .parse(
          await invoke("update", { id: free, attributes: { "kanban/lane": "blocked" } }, false),
        ),
      /block/iu,
    );
    evidence.push(
      "pure Kanban protocol: no hidden Workflow dependency, held-scope detach/burn/retirement, progression deletion and truthful lane guards",
    );
  }

  async function exerciseDefinitionHash(): Promise<void> {
    const source = catalog.find(({ name }) => name === "parallel")!.source;
    const contents = await Bun.file(source).text();
    await Bun.write(source, contents.replace("Prepare change", "Revised preparation"));
    const hot = runView.parse(await cli(["workflow", "start", "parallel"]));
    assert.deepEqual(
      hot.tasks.map(({ title }) => title),
      ["Revised preparation"],
    );
    await deniedCli(["workflow", "show", prepare], /saved hash/iu);
    await host.botlake(["lake", "restart", "--workspace", workspace]);
    await deniedCli(["workflow", "show", prepare], /saved hash/iu);
    const fresh = runView.parse(await cli(["workflow", "start", "parallel"]));
    assert.deepEqual(
      fresh.tasks.map(({ title }) => title),
      ["Revised preparation"],
    );
    evidence.push("module cache honesty, saved definition hash and fresh restart ingestion");
  }

  async function exerciseTransformedFixture(): Promise<void> {
    const source = join(workspace, "transformed.ts");
    await Bun.write(
      source,
      `import { assign, createMachine } from "xstate";
import { z } from "zod";
export const inputSchema = z.object({});
export const commandSchemas = {
  next: z.object({ value: z.string().transform(Number), evidence: z.string().optional() }),
};
export function runBrief() {
  return { title: "Command transformation", description: "Preserve original results" };
}
export const machine = createMachine({
  id: "transformed",
  initial: "work",
  context: { saved: null },
  states: {
    work: {
      meta: {
        title: "Work",
        commands: { next: "NEXT" },
        task: () => ({ instructions: "Submit a positive value and retain the verification evidence. ".repeat(200) }),
      },
      on: {
        NEXT: {
          target: "done",
          guard: ({ event }) => event.data.value > 0,
          actions: assign({ saved: ({ event }) => event.data }),
        },
      },
    },
    done: { type: "final" },
  },
});
`,
    );
    await host.botlake(["lake", "restart", "--workspace", workspace]);
    const run = runView.parse(await cli(["workflow", "start", "--source", source]));
    const worker = task(run, "Work");
    const checkpoint = await call("show", { id: run.run.id });
    await deniedCli(
      ["workflow", "complete", worker, "next", "--data", '{"value":"0"}'],
      /unavailable/iu,
    );
    assert.deepEqual(await call("show", { id: run.run.id }), checkpoint);
    await deniedCli(
      ["workflow", "complete", worker, "next", "--data", '{"value":0}'],
      /validation/iu,
    );
    assert.deepEqual(await call("show", { id: run.run.id }), checkpoint);
    const richDetail = await cli(["workflow", "show", worker]);
    measure("longInstructionsTaskDetail", richDetail);
    measure("longInstructionsRun", await cli(["workflow", "show", run.run.id]));
    assert.ok(payloadBytes["longInstructionsTaskDetail"]! > 10000);
    assert.ok(payloadBytes["longInstructionsRun"]! < 1000);
    const original = { value: "13", evidence: "Verified input and observed output. ".repeat(300) };
    await complete(worker, "next", original);
    const compactHistory = await cli(["workflow", "show", run.run.id]);
    measure("largeOutcomeRunHistory", compactHistory);
    measure("largeOutcomeTaskDetail", await cli(["workflow", "show", worker]));
    assert.ok(payloadBytes["largeOutcomeRunHistory"]! < 1000);
    const completed = runView.parse(compactHistory);
    assert.equal(completed.run.status, "complete");
    await complete(worker, "next", original);
    await deniedCli(
      ["workflow", "complete", worker, "next", "--data", '{"value":"013"}'],
      /different saved original/iu,
    );
    const snapshot = z
      .object({ attributes: z.record(z.string(), z.unknown()) })
      .parse(await call("show", { id: run.run.id })).attributes["workflow/snapshot"];
    assert.match(z.string().parse(snapshot), /"value":13/u);
    await host.botlake(["lake", "restart", "--workspace", workspace]);
    assert.deepEqual(await show(run.run.id), completed);
    evidence.push(
      "guard/schema atomicity, one transform, original-payload idempotency and conflict",
    );
  }
} finally {
  await host.close();
}
