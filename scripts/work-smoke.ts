// Pack/install outside the checkout, exercise the real CLI, and remove every disposable lake.
import assert from "node:assert/strict";

import { workAttributes } from "@botlake/extension-work";
import { z } from "zod";

import { system } from "../tests/blackbox/fixtures/system.ts";

const identifier = z.object({ id: z.string() });
const criterion = z.object({
  id: z.string(),
  condition: z.string(),
  state: z.enum(["open", "resolved"]),
  resolution: z.object({ text: z.string(), by: z.string(), at: z.string() }).nullable(),
});
const task = z.object({
  id: z.string(),
  kind: z.literal("task"),
  title: z.string(),
  description: z.string(),
  state: z.enum(["open", "closed"]),
  revision: z.number(),
  notes: z.string().nullable(),
  acceptanceCriteria: z.array(criterion),
  assignee: z.string().nullable(),
  assignment: z.object({ id: z.string(), assignee: z.string() }).nullable(),
  audience: z.enum(["AFK", "HITL"]),
  origin: z.enum(["planned", "unplanned"]),
  priority: z.string(),
  closedBy: z.string().nullable(),
  closedAt: z.string().nullable(),
});
const group = z.object({
  id: z.string(),
  kind: z.literal("group"),
  title: z.string(),
  state: z.enum(["open", "closed"]),
});
const summary = z.strictObject({
  id: z.string(),
  kind: z.enum(["task", "group"]),
  title: z.string(),
  state: z.enum(["open", "closed"]),
  ready: z.boolean(),
  assignee: z.string().nullable(),
  audience: z.string().nullable(),
  origin: z.string().nullable(),
  priority: z.string().nullable(),
  parent: z.string().nullable(),
});
const page = z.object({
  items: z.array(summary),
  total: z.number(),
  nextOffset: z.number().nullable(),
});
const detail = z.object({
  item: z.discriminatedUnion("kind", [task, group]),
  context: z.array(group),
  ready: z.boolean(),
  prerequisites: z.array(summary),
  references: z.array(summary),
  members: page,
  history: z
    .object({
      assignments: z.array(
        z.object({
          id: z.string(),
          assignee: z.string(),
          release: z.object({ reason: z.string() }).nullable(),
        }),
      ),
      criteria: z.array(
        z.object({
          id: z.string(),
          changes: z.array(z.object({ kind: z.string(), text: z.string() })),
        }),
      ),
      closures: z.array(z.object({ by: z.string() })),
      reopenings: z.array(z.object({ reason: z.string() })),
    })
    .optional(),
});

const host = await system();
const evidence: string[] = [];
try {
  const workspace = await host.workspace("work-smoke", [
    "@botlake/extension-batteries",
    "@botlake/extension-identity",
    "@botlake/extension-work",
  ]);
  await host.botlake(["lake", "start", "--workspace", workspace]);
  const cli = (args: string[], ok = true) => host.cli(["--workspace", workspace, ...args], ok);
  const call = (input: unknown, ok = true) => host.bl(workspace, "work", input, ok);
  const create = async (title: string, fields: Record<string, unknown> = {}) =>
    identifier.parse(await call({ command: "create", title, by: "smoke", ...fields })).id;
  const show = async (id: string, history = false) =>
    detail.parse(await call({ command: "show", id, history }));
  const list = async (fields: Record<string, unknown> = {}) =>
    page.parse(await call({ command: "list", ...fields }));
  const close = (id: string) => call({ command: "close", id, by: "smoke" });
  const failure = async (input: unknown, match: RegExp) => {
    assert.match(z.string().parse(await call(input, false)), match);
  };
  const ids = (result: z.infer<typeof page>) => result.items.map(({ id }) => id);

  // Zero-criterion investigation, retained findings and retrospective contextual placement.
  const investigation = await create("Compare engines", { description: "Research-first scope" });
  await call({
    command: "update",
    id: investigation,
    notes: "Candidate X is unsuitable; candidate Y remains viable.",
  });
  await close(investigation);
  const scope = await create("Workflow engine", {
    kind: "group",
    description: "Build reusable user-authored control flow",
  });
  await cli(["work", "move", investigation, "--parent", scope]);
  assert.equal((await show(investigation)).context[0]?.id, scope);
  assert.equal((await show(investigation)).item.state, "closed");
  assert.ok(ids(await list({ search: "candidate x" })).includes(investigation));
  evidence.push("optional criteria, closed-work findings search, retrospective shared context");

  // Parallel trials are independent; join readiness means settled work, not success.
  const trials = await create("Candidate trials", { kind: "group", parent: scope });
  const x = await create("Try X", { parent: trials });
  const y = await create("Try Y", { parent: trials });
  const delivery = await create("Build the selected approach", {
    parent: scope,
    prerequisites: [x, y],
  });
  const added = criterion.parse(
    await cli(["work", "criterion", "add", x, "Record a runnable result", "--by", "smoke"]),
  );
  assert.equal((await show(x)).ready, true);
  await failure({ command: "close", id: x, by: "smoke" }, /criterion/iu);
  await cli([
    "work",
    "criterion",
    "resolve",
    x,
    added.id,
    "Unmet: candidate cannot support the requirement",
    "--by",
    "reviewer",
  ]);
  await close(x);
  assert.equal((await show(delivery)).ready, false);
  assert.equal((await show(y)).item.state, "open");
  await close(y);
  assert.equal((await show(delivery)).ready, true);
  assert.equal((await show(delivery)).item.state, "open");
  evidence.push(
    "parallel prerequisites, late criteria, explicit unmet resolution, no downstream auto-completion",
  );

  // Groups are non-actionable, nested, closable prerequisites. Closing a leaf ignores siblings.
  await failure({ command: "claim", id: trials, assignee: "agent", by: "agent" }, /Only tasks/iu);
  await failure(
    { command: "create", kind: "task", title: "Invalid child", parent: delivery },
    /Only groups/iu,
  );
  await failure({ command: "close", id: scope, by: "smoke" }, /contained tasks/iu);
  await close(trials);
  const review = await create("Review both deliveries", {
    parent: scope,
    prerequisites: [trials, delivery],
    audience: "HITL",
    assignee: "human",
    priority: "P1",
  });
  const nextGroup = await create("Follow-on context", { kind: "group", prerequisites: [trials] });
  assert.equal((await show(nextGroup)).ready, true);
  await close(delivery);
  assert.ok(ids(await list({ view: "human", assignee: "human" })).includes(review));
  await close(review);
  await close(scope);
  evidence.push(
    "group lifecycle, nested task closure guard, group prerequisites, routed human checkpoint",
  );

  // History-preserving recovery cannot silently resurrect work below a closed group.
  await failure(
    { command: "reopen", id: x, reason: "Correction", by: "editor" },
    /containing groups/iu,
  );
  await call({ command: "reopen", id: scope, reason: "Recovery", by: "editor" });
  await call({ command: "reopen", id: trials, reason: "Recovery", by: "editor" });
  await call({ command: "reopen", id: x, reason: "Correction", by: "editor" });
  assert.equal(task.parse((await show(x)).item).acceptanceCriteria[0]?.state, "resolved");
  await cli([
    "work",
    "criterion",
    "correct",
    x,
    added.id,
    "Correction: evidence was incomplete",
    "--by",
    "editor",
  ]);
  await cli(["work", "criterion", "reopen", x, added.id, "Reassess explicitly", "--by", "editor"]);
  await failure({ command: "close", id: x, by: "editor" }, /criterion/iu);
  await cli([
    "work",
    "criterion",
    "resolve",
    x,
    added.id,
    "No longer required; replace with production follow-up",
    "--by",
    "editor",
  ]);
  await close(x);
  const recovered = await show(x, true);
  assert.equal(recovered.history?.criteria[0]?.changes.length, 4);
  assert.equal(recovered.history?.closures.length, 2);
  assert.equal(task.parse(recovered.item).acceptanceCriteria[0]?.condition, added.condition);
  await cli([
    "work",
    "criterion",
    "correct",
    x,
    added.id,
    "Historical annotation: replacement scope is recorded separately",
    "--by",
    "editor",
  ]);
  assert.equal((await show(x)).item.state, "closed");
  assert.equal((await show(x, true)).history?.criteria[0]?.changes.length, 5);
  evidence.push(
    "recovery retains conditions, prior assessments, closure attribution and explicit corrections",
  );

  // A shared human impediment survives assignment release; stale releases cannot steal ownership.
  const build = await create("Build remote demonstration");
  const claim = z
    .object({ assignment: z.object({ id: z.string() }) })
    .parse(await call({ command: "claim", id: build, assignee: "worker-one", by: "worker-one" }));
  const vpn = await create("Enable VPN", {
    audience: "HITL",
    origin: "unplanned",
    assignee: "human",
    priority: "P3",
  });
  await call({ command: "link", from: build, to: vpn, relation: "depends-on" });
  assert.ok(ids(await list({ view: "assigned" })).includes(build));
  assert.ok(ids(await list({ view: "waiting" })).includes(build));
  await call({
    command: "release",
    id: build,
    assignmentId: claim.assignment.id,
    reason: "Worker ended",
    by: "liveness",
  });
  assert.ok(!ids(await list({ view: "available" })).includes(build));
  assert.ok(!ids(await list({ view: "available" })).includes(vpn));
  assert.ok(
    ids(await list({ view: "human", assignee: "human", origin: "unplanned" })).includes(vpn),
  );
  await close(vpn);
  const current = z
    .object({ assignment: z.object({ id: z.string() }) })
    .parse(await call({ command: "claim", id: build, assignee: "worker-two", by: "worker-two" }));
  assert.equal(
    z.object({ released: z.boolean() }).parse(
      await call({
        command: "release",
        id: build,
        assignmentId: claim.assignment.id,
        reason: "Delayed old observation",
        by: "liveness",
      }),
    ).released,
    false,
  );
  assert.equal(task.parse((await show(build)).item).assignment?.id, current.assignment.id);
  await failure(
    { command: "claim", id: build, assignee: "worker-three", by: "worker-three" },
    /already assigned/iu,
  );
  const buildHistory = await show(build, true);
  assert.equal(buildHistory.history?.assignments.length, 2);
  assert.equal(buildHistory.prerequisites[0]?.id, vpn);
  evidence.push(
    "assigned-and-waiting awareness, AFK eligibility, persistent HITL impediment, fenced ownership generations",
  );

  // References do not change context. Raw graph operations cannot bypass the public invariants.
  const elsewhere = await create("Other context", { kind: "group" });
  await call({ command: "link", from: elsewhere, to: x, relation: "references" });
  assert.deepEqual(
    (await show(x)).context.map(({ id }) => id),
    [scope, trials],
  );
  await failure({ command: "link", from: vpn, to: build, relation: "depends-on" }, /Cycle/iu);
  for (const [op, input] of [
    ["update", { id: x, attributes: { [workAttributes.data]: "{}" } }],
    ["burn", { ids: [x] }],
    ["archive", { id: x, keys: [workAttributes.data] }],
    ["edge", { command: "add", from: elsewhere, to: x, relation: "parent-of" }],
  ] as const)
    assert.ok(z.string().parse(await host.bl(workspace, op, input, false)).length > 0);
  evidence.push(
    "single contextual home, non-contextual references, cycles and generic mutation guards",
  );

  // Defaults, urgency independent of origin, full findings only on detail, explicit pagination.
  const defaultTask = task.parse((await show(await create("Default policy"))).item);
  assert.deepEqual(
    [defaultTask.audience, defaultTask.origin, defaultTask.priority],
    ["AFK", "planned", "P2"],
  );
  const planned = await create("Immediate planned handoff", {
    audience: "HITL",
    assignee: "human",
    priority: "P0",
  });
  const interruption = await create("Low urgency interruption", {
    audience: "HITL",
    assignee: "human",
    origin: "unplanned",
    priority: "P4",
  });
  const humanQueue = ids(await list({ view: "human", assignee: "human" }));
  assert.ok(humanQueue.indexOf(planned) < humanQueue.indexOf(interruption));
  const longNotes = "Durable findings and supporting evidence. ".repeat(4000);
  await call({ command: "update", id: planned, notes: longNotes });
  const compact = await call({ command: "list", limit: 1 });
  const first = page.parse(compact);
  assert.ok(first.nextOffset !== null);
  assert.ok(JSON.stringify(compact).length < longNotes.length / 10);
  assert.equal(task.parse((await show(planned)).item).notes, longNotes);
  const collected: string[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const result = await list({ state: "all", limit: 3, offset });
    collected.push(...ids(result));
    offset = result.nextOffset;
  }
  assert.equal(new Set(collected).size, (await list({ state: "all" })).total);
  evidence.push(
    "AFK/planned/P2 defaults, independent urgency, compact lists, expandable findings and complete pagination",
  );

  await host.botlake(["lake", "restart", "--workspace", workspace]);
  assert.equal(task.parse((await show(build)).item).assignment?.id, current.assignment.id);
  assert.equal((await show(x, true)).history?.criteria[0]?.changes.length, 5);
  assert.equal(task.parse((await show(planned)).item).notes, longNotes);
  evidence.push(
    "restart preserves task facts, criterion history, relationships and current assignment",
  );
  console.log(JSON.stringify({ ok: true, evidence }, null, 2));
} finally {
  await host.close();
}
