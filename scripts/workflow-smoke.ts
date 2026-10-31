// Disposable black-box smoke for the Workflow/Work ownership seam.
import assert from "node:assert/strict";
import { join } from "node:path";

import { attributesSchema, q } from "@botlake/core";
import { workflowAttributes } from "@botlake/extension-workflow";
import { z } from "zod";

import { system } from "../tests/blackbox/fixtures/system.ts";
import { copyWorkflowExample } from "../tests/blackbox/fixtures/workflows.ts";

const idResult = z.object({ id: z.string() });
const summary = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(["ready", "blocked", "done"]),
  actionPending: z.boolean(),
});
const runView = z.object({
  run: z.object({
    id: z.string(),
    context: z.string(),
    title: z.string(),
    status: z.enum(["active", "blocked", "complete"]),
  }),
  tasks: z.array(summary),
  history: z.array(z.object({ id: z.string(), title: z.string(), choice: z.string() })),
  taskPage: z.object({ total: z.number(), nextOffset: z.number().nullable() }),
  historyPage: z.object({ total: z.number(), nextOffset: z.number().nullable() }),
});
const workDetail = z.object({
  item: z.object({
    id: z.string(),
    kind: z.enum(["task", "group"]),
    title: z.string(),
    state: z.enum(["open", "closed"]),
  }),
  context: z.array(z.object({ id: z.string(), kind: z.literal("group") })),
  prerequisites: z.array(z.object({ id: z.string(), state: z.enum(["open", "closed"]) })),
  ready: z.boolean(),
});

const host = await system();
try {
  const workspace = await host.workspace("workflow-smoke", [
    "@botlake/extension-batteries",
    "@botlake/extension-identity",
    "@botlake/extension-work",
    "@botlake/extension-workflow",
  ]);
  await copyWorkflowExample(workspace, "parallel");
  await copyWorkflowExample(workspace, "nested-machines");
  await Bun.write(
    join(workspace, "rollback.ts"),
    `
import { setup } from "xstate";
import { z } from "zod";
export const inputSchema = z.object({});
export const commandSchemas = { next: z.object({ proof: z.string().min(1) }) };
export function runBrief() { return { title: "Atomic rollback", description: "No partial work effects" }; }
export const machine = setup({}).createMachine({
  initial: "first",
  states: {
    first: {
      meta: {
        title: "Human proof", commands: { next: "NEXT" },
        task: () => ({ instructions: "Record evidence", acceptanceCriteria: ["Record findings"], audience: "HITL", assignee: "human", priority: "P0" }),
      },
      on: { NEXT: "second" },
    },
    second: { meta: { title: "Rejected publication", commands: { next: "DONE" }, task: () => { throw new Error("publication rejected"); } }, on: { DONE: "done" } },
    done: { type: "final" },
  },
});
`,
  );
  await Bun.write(
    join(workspace, "native-values.ts"),
    `
import { setup } from "xstate";
import { z } from "zod";
export const inputSchema = z.object({ nullable: z.null(), nested: z.object({ value: z.null() }), items: z.array(z.null()) });
export const commandSchemas = { finish: z.json() };
export function runBrief() { return { title: "Native values", description: "Preserve authored JSON" }; }
export const machine = setup({ types: { input: {} as z.infer<typeof inputSchema>, context: {} as z.infer<typeof inputSchema> } }).createMachine({
  context: ({ input }) => input,
  initial: "task",
  states: {
    task: {
      meta: {
        title: "Native JSON task", commands: { finish: "FINISH" },
        task: () => ({ instructions: "Publish native values", evidence: { label: "native", nullable: null, nested: { value: null } } }),
      },
      on: { FINISH: "done" },
    },
    done: { type: "final" },
  },
});
`,
  );
  await host.botlake(["lake", "start", "--workspace", workspace]);
  const cli = (args: string[], ok = true) => host.cli(["--workspace", workspace, ...args], ok);
  const showRun = async (id: string) => runView.parse(await cli(["workflow", "show", id]));
  const task = (view: z.infer<typeof runView>, title: string) =>
    z.string().parse(view.tasks.find((candidate) => candidate.title === title)?.id);

  const started = runView.parse(await cli(["workflow", "start", "parallel"]));
  const prepare = task(started, "Prepare change");
  const prepareWork = workDetail.parse(await cli(["work", "show", prepare]));
  assert.equal(prepareWork.item.kind, "task");
  assert.equal(prepareWork.context[0]?.id, started.run.context);

  const prerequisite = idResult.parse(
    await cli(["work", "create", "Independent prerequisite", "--parent", started.run.context]),
  ).id;
  await cli(["work", "link", prepare, prerequisite, "--relation", "depends-on"]);
  assert.equal((await showRun(started.run.id)).tasks[0]?.status, "blocked");
  assert.match(
    z.string().parse(await cli(["workflow", "complete", prepare, "next"], false)),
    /prerequisite/iu,
  );
  await cli(["work", "close", prerequisite]);

  await cli(["work", "claim", prepare, "--assignee", "human-reviewer"]);
  assert.equal(
    z
      .object({ item: z.object({ assignee: z.string().nullable() }) })
      .parse(await cli(["work", "show", prepare])).item.assignee,
    "human-reviewer",
  );

  // Generic closure is deliberately inert. Explicit completion may consume that closed visit later.
  await cli(["work", "close", prepare]);
  assert.equal(
    (await showRun(started.run.id)).tasks.find(({ id }) => id === prepare)?.actionPending,
    true,
  );
  assert.equal((await showRun(started.run.id)).history.length, 0);
  const branches = runView.parse(await cli(["workflow", "complete", prepare, "next"]));
  assert.deepEqual(branches.tasks.map(({ title }) => title).toSorted(), [
    "Implement API",
    "Write docs",
  ]);
  assert.equal(branches.history[0]?.id, prepare);

  // Matching raw retries are idempotent; a conflicting retry is rejected.
  assert.deepEqual(runView.parse(await cli(["workflow", "complete", prepare, "next"])), branches);
  assert.match(
    z.string().parse(await cli(["workflow", "complete", prepare, "approved"], false)),
    /different saved original result/iu,
  );

  await host.botlake(["lake", "restart", "--workspace", workspace]);
  assert.deepEqual(await showRun(started.run.id), branches);
  assert.match(
    z
      .string()
      .parse(
        await cli(["work", "reopen", prepare, "--reason", "attempt consumed recovery"], false),
      ),
    /consumed/iu,
  );

  const complete = async (id: string, choice = "next") =>
    runView.parse(await cli(["workflow", "complete", id, choice]));
  const api = task(branches, "Implement API");
  const docs = task(branches, "Write docs");
  const verifying = await complete(api);
  assert.equal(task(verifying, "Write docs"), docs);
  const checking = await complete(docs);
  const firstReview = task(checking, "Check docs");
  await cli(["work", "update", firstReview, "--notes", "Changes requested: fix the usage example"]);
  const revised = await complete(firstReview, "revise");
  const rewrite = task(revised, "Write docs");
  assert.notEqual(rewrite, docs);
  const secondReview = task(await complete(rewrite), "Check docs");
  assert.notEqual(secondReview, firstReview);
  const oldReview = z
    .object({ item: z.object({ state: z.literal("closed"), notes: z.string() }) })
    .parse(await cli(["work", "show", firstReview]));
  assert.match(oldReview.item.notes, /Changes requested/iu);
  const docsDone = await complete(secondReview, "approved");
  assert.equal(
    docsDone.tasks.some(({ title }) => title === "Hand off change"),
    false,
  );
  const handoff = task(await complete(task(docsDone, "Verify API")), "Hand off change");
  const done = await complete(handoff);
  assert.equal(done.run.status, "complete");
  assert.equal(
    workDetail.parse(await cli(["work", "show", done.run.context])).item.state,
    "closed",
  );
  const firstPage = runView.parse(await cli(["workflow", "show", done.run.id, "--limit", "2"]));
  assert.equal(firstPage.history.length, 2);
  assert.equal(firstPage.historyPage.nextOffset, 2);
  const nextPage = runView.parse(
    await cli(["workflow", "show", done.run.id, "--limit", "2", "--history-offset", "2"]),
  );
  assert.equal(
    nextPage.history.some(({ id }) => firstPage.history.some((old) => old.id === id)),
    false,
  );

  // Private execution checkpoints and decision evidence cannot be forged or erased through Batteries.
  for (const [command, input] of [
    ["update", { id: done.run.id, attributes: { [workflowAttributes.snapshot]: "{}" } }],
    ["update", { id: firstReview, attributes: { [workflowAttributes.result]: "{}" } }],
    [
      "set-attributes",
      {
        id: firstReview,
        attributes: { [workflowAttributes.result]: { choice: "forged", data: null } },
      },
    ],
    ["burn", { ids: [done.run.id] }],
    ["archive", { id: done.run.id, keys: [workflowAttributes.snapshot] }],
  ] as const)
    assert.ok(
      z.string().parse(await host.bl(workspace, "node", { command, ...input }, false)).length > 0,
    );

  // Nested machine routing restores after restart. Context and business scope can outlive execution.
  const business = idResult.parse(
    await cli(["work", "create", "Business scope", "--kind", "group"]),
  ).id;
  let nested = runView.parse(
    await cli(["workflow", "start", "nested-machines", "--parent", business]),
  );
  const followup = idResult.parse(
    await cli(["work", "create", "Independent follow-up", "--parent", nested.run.context]),
  ).id;
  const nestedApi = task(nested, "Implement API");
  const nestedInterface = task(nested, "Implement interface");
  assert.ok(
    workDetail
      .parse(await cli(["work", "show", nestedApi]))
      .context.every(({ kind }) => kind === "group"),
  );
  nested = await complete(nestedApi);
  await host.botlake(["lake", "restart", "--workspace", workspace]);
  assert.deepEqual(await showRun(nested.run.id), nested);
  nested = await complete(nestedInterface);
  nested = await complete(task(nested, "Verify API"));
  nested = await complete(task(nested, "Verify interface"));
  nested = await complete(task(nested, "Summarize both branches"));
  assert.equal(nested.run.status, "complete");
  assert.equal(
    workDetail.parse(await cli(["work", "show", nested.run.context])).item.state,
    "open",
  );
  assert.equal(workDetail.parse(await cli(["work", "show", business])).item.state, "open");
  await cli(["work", "close", followup]);
  await cli(["work", "close", nested.run.context]);
  assert.equal(workDetail.parse(await cli(["work", "show", business])).item.state, "open");

  // Authored values are queryable native JSON; only the execution snapshot is opaque.
  const input = { nullable: null, nested: { value: null }, items: [null] };
  const native = runView.parse(
    await cli([
      "workflow",
      "start",
      "--source",
      "native-values.ts",
      "--input",
      JSON.stringify(input),
    ]),
  );
  const nativeTask = task(native, "Native JSON task");
  const attributes = async (id: string) =>
    z
      .object({ attributes: attributesSchema })
      .parse(await host.bl(workspace, "node", { command: "show", id })).attributes;
  const runAttributes = await attributes(native.run.id);
  assert.equal(typeof runAttributes[workflowAttributes.definition], "object");
  assert.equal(typeof runAttributes[workflowAttributes.snapshot], "string");
  const published = await attributes(nativeTask);
  assert.deepEqual(published[workflowAttributes.context], input);
  assert.deepEqual(
    z.object({ evidence: z.unknown() }).parse(published[workflowAttributes.meta]).evidence,
    {
      label: "native",
      nullable: null,
      nested: { value: null },
    },
  );
  const matching = z.array(idResult).parse(
    await host.bl(workspace, "node", {
      command: "list",
      where: q.eq(q.attr(workflowAttributes.meta, "evidence", "label"), "native"),
    }),
  );
  assert.ok(matching.some(({ id }) => id === nativeTask));
  const result = { nullable: null, nested: { value: null } };
  const completed = await cli([
    "workflow",
    "complete",
    nativeTask,
    "finish",
    "--data",
    JSON.stringify(result),
  ]);
  assert.deepEqual((await attributes(nativeTask))[workflowAttributes.result], {
    choice: "finish",
    data: result,
  });
  await host.botlake(["lake", "restart", "--workspace", workspace]);
  assert.deepEqual((await attributes(nativeTask))[workflowAttributes.context], input);
  assert.deepEqual(
    await cli(["workflow", "complete", nativeTask, "finish", "--data", JSON.stringify(result)]),
    completed,
  );
  assert.match(
    z
      .string()
      .parse(await cli(["workflow", "complete", nativeTask, "finish", "--data", "null"], false)),
    /different saved original result/iu,
  );
  const nullable = runView.parse(
    await cli([
      "workflow",
      "start",
      "--source",
      "native-values.ts",
      "--input",
      JSON.stringify(input),
    ]),
  );
  const nullableTask = task(nullable, "Native JSON task");
  await cli(["workflow", "complete", nullableTask, "finish", "--data", "null"]);
  assert.deepEqual((await attributes(nullableTask))[workflowAttributes.result], {
    choice: "finish",
    data: null,
  });

  // A failed next-publication rolls back closure, assignment release, checkpoint and authored result.
  const rollback = runView.parse(await cli(["workflow", "start", "--source", "rollback.ts"]));
  const proof = task(rollback, "Human proof");
  const humanQueue = z
    .object({ items: z.array(z.object({ id: z.string() })) })
    .parse(await cli(["work", "list", "--view", "human", "--assignee", "human"]));
  assert.ok(humanQueue.items.some(({ id }) => id === proof));
  assert.match(
    z
      .string()
      .parse(
        await cli(["workflow", "complete", proof, "next", "--data", '{"proof":"recorded"}'], false),
      ),
    /criterion/iu,
  );
  const proofCriterion = z
    .object({ item: z.object({ acceptanceCriteria: z.array(z.object({ id: z.string() })) }) })
    .parse(await cli(["work", "show", proof])).item.acceptanceCriteria[0];
  if (proofCriterion === undefined) throw new Error("Missing authored criterion");
  await cli(["work", "criterion", "resolve", proof, proofCriterion.id, "Met: findings recorded"]);
  const before = await cli(["work", "show", proof, "--history"]);
  assert.match(
    z
      .string()
      .parse(
        await cli(["workflow", "complete", proof, "next", "--data", '{"proof":"recorded"}'], false),
      ),
    /publication rejected/iu,
  );
  assert.deepEqual(await cli(["work", "show", proof, "--history"]), before);
  assert.deepEqual(await showRun(rollback.run.id), rollback);

  console.log(
    JSON.stringify(
      {
        ok: true,
        verified: [
          "shared Work model, private execution, prerequisite gating and common assignment ledger",
          "inert generic closure remains discoverable as a pending authored action",
          "parallel branch independence, explicit outcomes, fresh revision visits and retained findings",
          "bounded action/decision pages with explicit continuation",
          "private checkpoint/result protection and consumed-visit recovery guard",
          "nested machine routes and checkpoint restore after restart",
          "native queryable metadata, context, locator and results preserve nulls and retry equality across restart",
          "business/context groups may outlive execution without false completion",
          "authored HITL routing and criteria, atomic rollback of all completion effects",
        ],
      },
      null,
      2,
    ),
  );
} finally {
  await host.close();
}
