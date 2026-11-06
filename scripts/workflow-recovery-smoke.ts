// Run: bun scripts/workflow-recovery-smoke.ts — disposable SQLite, packed CLIs and deliberate worker exits.
import assert from "node:assert/strict";
import { join } from "node:path";

import { attributesSchema, ManualClock, q, Runtime } from "@botlake/core";
import { identity } from "@botlake/extension-identity";
import {
  defineProbe,
  gateProbes,
  work,
  workStore,
  type GateCommand,
} from "@botlake/extension-work";
import { workflowAttributes as attrs, workflows } from "@botlake/extension-workflow";
import { z } from "zod";

import { system } from "../tests/blackbox/fixtures/system.ts";
import { copyWorkflowExample } from "../tests/blackbox/fixtures/workflows.ts";

const idSchema = z.object({ id: z.string() });
const viewSchema = z.object({
  run: z.object({ id: z.string(), status: z.string() }),
  tasks: z.array(idSchema),
  gates: z.array(idSchema),
  history: z.array(idSchema),
});
const captureSchema = z.object({
  id: z.string(),
  publication: z.object({
    entries: z.array(z.object({ identity: z.string() })),
    done: z.boolean(),
  }),
});
const host = await system();
try {
  const workspace = await host.workspace("workflow-recovery", [
    "@botlake/extension-batteries",
    "@botlake/extension-identity",
    "@botlake/extension-workflow",
    "./work.ts",
    "./crash.ts",
  ]);
  await Bun.write(
    join(workspace, "work.ts"),
    `
import { defineProbe, work } from "@botlake/extension-work";
import { z } from "zod";
export default work({ probes: [defineProbe({
  name: "quiet", description: "Controlled smoke gate", params: z.object({}),
  policy: { everyMs: 3600000, maxAttempts: 2, timeoutMs: 1000 },
  async run() { return { outcome: "failed", message: "not yet" }; },
})] });
`,
  );
  // Exit from an after-commit subscriber, while reconciliation awaits the catalogue.
  await Bun.write(
    join(workspace, "crash.ts"),
    `
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workflowAttributes as attrs } from "@botlake/extension-workflow";
export default {
  name: "crash", requires: ["workflow"],
  activate(ctx) {
    ctx.graph.declareImmutable("consumer/fact");
    ctx.subscribe(({ changes }) => {
      const arm = join(ctx.workspace, "crash.arm");
      for (const change of changes) {
        const node = change.kind === "node" ? change.after : null;
        if (!node || node.attributes[attrs.root] !== true || !node.attributes[attrs.publication] || !existsSync(arm)) continue;
        writeFileSync(join(ctx.workspace, "captured.json"), JSON.stringify({ id: node.id, publication: node.attributes[attrs.publication] }));
        unlinkSync(arm);
        process.exit(73);
      }
    });
  },
};
`,
  );
  await Bun.write(
    join(workspace, "recovery.ts"),
    `
import { readFileSync } from "node:fs";
import { setup } from "xstate";
import { z } from "zod";
export const inputSchema = z.object({ marker: z.string() });
export const commandSchemas = { again: z.object({}), finish: z.object({}) };
export function runBrief() { return { title: "Recover publication", description: "Durable self-loop visits" }; }
export const machine = setup({}).createMachine({
  context: ({ input }) => input,
  initial: "work",
  states: {
    work: {
      meta: {
        title: "Recoverable worker", commands: { again: "AGAIN", finish: "FINISH" },
        task: ({ context }) => ({ instructions: "Check the frozen marker", inert: true, attributes: { "consumer/opt-in": true, "consumer/frozen": readFileSync(context.marker, "utf8"), "consumer/nulls": { nested: null, items: [null] } } }),
        gates: () => [{ title: "Recoverable prerequisite", probe: "quiet", params: {} }],
      },
      on: { AGAIN: { target: "work", reenter: true }, FINISH: "done" },
    },
    done: { type: "final" },
  },
});
`,
  );
  await Bun.write(
    join(workspace, "reserved.ts"),
    `
import { setup } from "xstate";
import { z } from "zod";
export const inputSchema = z.object({ attributes: z.record(z.string(), z.json()), group: z.boolean().default(false) });
export const commandSchemas = { done: z.object({}) };
export function runBrief() { return { title: "Reserved fields", description: "Reject protected task attributes" }; }
export const machine = setup({}).createMachine({
  context: ({ input }) => input,
  initial: "choose",
  states: {
    choose: { always: [{ guard: ({ context }) => context.group, target: "group" }, { target: "work" }] },
    work: { meta: { title: "Protected worker", commands: { done: "DONE" }, task: ({ context }) => ({ instructions: "No overwrites", attributes: context.attributes }) }, on: { DONE: "done" } },
    group: { meta: { title: "Protected group", task: ({ context }) => ({ instructions: "No task fields", attributes: context.attributes }) } },
    done: { type: "final" },
  },
});
`,
  );
  await gateEvidence(workspace);
  await host.botlake(["lake", "start", "--workspace", workspace]);
  const cli = (args: string[], ok = true) => host.cli(["--workspace", workspace, ...args], ok);
  const node = async (id: string) =>
    z
      .object({ attributes: attributesSchema })
      .parse(await host.bl(workspace, "node", { command: "show", id })).attributes;
  const captured = async () =>
    captureSchema.parse(await Bun.file(join(workspace, "captured.json")).json());
  const restart = () => host.botlake(["lake", "restart", "--workspace", workspace]);
  const show = async (id: string) => viewSchema.parse(await cli(["workflow", "show", id]));
  const firstTask = (view: z.infer<typeof viewSchema>) => z.string().parse(view.tasks[0]?.id);
  const arm = () => Bun.write(join(workspace, "crash.arm"), "armed");
  const marker = join(workspace, "marker.txt");
  const startArgs = [
    "workflow",
    "start",
    "--source",
    "recovery.ts",
    "--input",
    JSON.stringify({ marker }),
  ];

  for (const key of [
    "work/kind",
    "work/new-owned-field",
    attrs.snapshot,
    "workflow/new-owned-field",
    "note/text",
    "consumer/fact",
  ])
    assert.match(
      z
        .string()
        .parse(
          await cli(
            [
              "workflow",
              "start",
              "--source",
              "reserved.ts",
              "--input",
              JSON.stringify({ attributes: { [key]: true } }),
            ],
            false,
          ),
        ),
      /owned facts/u,
    );
  assert.match(
    z
      .string()
      .parse(
        await cli(
          [
            "workflow",
            "start",
            "--source",
            "reserved.ts",
            "--input",
            JSON.stringify({ attributes: {}, group: true }),
          ],
          false,
        ),
      ),
    /Commandless/u,
  );

  await Bun.write(marker, "before-start");
  await arm();
  await cli(startArgs, false);
  const initial = await captured();
  await Bun.write(marker, "after-start");
  await restart();
  const first = await show(initial.id);
  const firstId = firstTask(first);
  assert.equal((await node(firstId))[attrs.identity], initial.publication.entries[0]?.identity);
  assert.equal((await node(firstId))["consumer/frozen"], "before-start");
  assert.deepEqual((await node(firstId))["consumer/nulls"], { nested: null, items: [null] });
  assert.equal((await node(firstId))["inert"], undefined);
  const detailSchema = z.object({ ready: z.boolean(), prerequisites: z.array(idSchema) });
  const firstWork = detailSchema.parse(await cli(["work", "show", firstId]));
  assert.equal(firstWork.ready, false);
  assert.equal(firstWork.prerequisites.length, 1);
  await cli([
    "gate",
    "clear",
    z.string().parse(firstWork.prerequisites[0]?.id),
    "--dismiss",
    "--reason",
    "smoke",
  ]);

  await Bun.write(marker, "before-loop");
  await arm();
  await cli(["workflow", "complete", firstId, "again"], false);
  const loop = await captured();
  assert.notEqual(loop.publication.entries[0]?.identity, initial.publication.entries[0]?.identity);
  await Bun.write(marker, "after-loop");
  await restart();
  const second = await show(initial.id);
  const secondId = firstTask(second);
  assert.notEqual(secondId, firstId);
  assert.equal((await node(secondId))[attrs.number], 2);
  assert.equal((await node(secondId))[attrs.identity], loop.publication.entries[0]?.identity);
  assert.equal((await node(secondId))["consumer/frozen"], "before-loop");
  assert.equal(second.history.length, 1);
  assert.deepEqual(
    await cli(["workflow", "complete", firstId, "again"]),
    await cli(["workflow", "show", initial.id]),
  );
  await restart();
  assert.deepEqual(await show(initial.id), second);
  const all = z
    .object({ nodes: z.array(idSchema) })
    .parse(
      await host.bl(workspace, "node", { command: "list", where: q.eq(q.attr(attrs.task), true) }),
    );
  assert.equal(all.nodes.length, 2, "No orphan or duplicate tasks after crash/restart");
  const gates = z.object({ nodes: z.array(idSchema) }).parse(
    await host.bl(workspace, "node", {
      command: "list",
      where: q.eq(q.attr("work/kind"), "gate"),
    }),
  );
  assert.equal(gates.nodes.length, 2, "No orphan or duplicate prerequisite gates");
  const secondWork = detailSchema.parse(await cli(["work", "show", secondId]));
  assert.equal(secondWork.ready, false);
  assert.equal(secondWork.prerequisites.length, 1);
  await cli([
    "gate",
    "clear",
    z.string().parse(secondWork.prerequisites[0]?.id),
    "--dismiss",
    "--reason",
    "smoke",
  ]);
  await arm();
  await cli(["workflow", "complete", secondId, "finish"], false);
  assert.equal((await captured()).publication.done, true);
  await restart();
  assert.equal((await show(initial.id)).run.status, "complete");
  assert.equal((await node(initial.id))[attrs.publication], null);
  console.log(
    JSON.stringify({
      ok: true,
      verified: [
        "all GateStatus snapshots in events/results, including evidence nulls",
        "initial pending mappings converge at start and stay unchanged on restart",
        "chained pending mappings after start, completion and gate events avoid queue re-entry and double consumption",
        "failed mapped delivery identifies the committed run and retries on show or identical completion without restart",
        "parallel gate events survive asynchronous publication and retain visit identity",
        "reserved namespaces and immutable facts rejected",
        "attributes visible with prerequisites, nulls preserved, arbitrary metadata inert",
        "real worker exits after start, self-loop completion and final checkpoint",
        "frozen rendering, durable visit identity and duplicate-free restart/retry",
        "exhausted gate reuse gets a fresh logical identity and retry round",
        "failed publication identifies its committed run and resumes on inspection",
      ],
    }),
  );
} finally {
  await host.close();
}

async function gateEvidence(workspace: string): Promise<void> {
  await Bun.write(
    join(workspace, "evidence.ts"),
    `
import { assign, setup } from "xstate";
import { z } from "zod";
export const inputSchema = z.object({ target: z.enum(["pending", "waiting", "exhausted", "cleared", "dismissed"]) });
export const commandSchemas = { done: z.object({}) };
export function runBrief() { return { title: "Gate evidence", description: "Retain the whole event" }; }
const remember = assign({ received: ({ event }) => event.data });
export const machine = setup({}).createMachine({
  context: ({ input }) => ({ target: input.target, received: null }), initial: "choose",
  states: {
    choose: { always: [
      { guard: ({ context }) => context.target === "pending", target: "pending" },
      { guard: ({ context }) => context.target === "waiting", target: "waiting" },
      { guard: ({ context }) => context.target === "exhausted", target: "exhausted" },
      { guard: ({ context }) => context.target === "cleared", target: "cleared" },
      { target: "dismissed" },
    ] },
    pending: { meta: { title: "Pending", gate: () => ({ probe: "quiet", params: {} }), on: { pending: "OBSERVED" } }, on: { OBSERVED: { target: "record", actions: remember } } },
    waiting: { meta: { title: "Waiting", gate: () => ({ probe: "quiet", params: {} }), on: { waiting: "OBSERVED" } }, on: { OBSERVED: { target: "record", actions: remember } } },
    exhausted: { meta: { title: "Exhausted", gate: () => ({ probe: "quiet", params: {} }), on: { exhausted: "OBSERVED" } }, on: { OBSERVED: { target: "record", actions: remember } } },
    cleared: { meta: { title: "Cleared", gate: () => ({ probe: "quiet", params: {} }), on: { cleared: "OBSERVED" } }, on: { OBSERVED: { target: "record", actions: remember } } },
    dismissed: { meta: { title: "Dismissed", gate: () => ({ probe: "quiet", params: {} }), on: { dismissed: "OBSERVED" } }, on: { OBSERVED: { target: "record", actions: remember } } },
    record: { meta: { title: "Recorded evidence", commands: { done: "DONE" }, task: ({ context }) => ({ instructions: "Inspect the whole status", attributes: { "consumer/evidence": context.received } }) }, on: { DONE: "done" } },
    done: { type: "final" },
  },
});
`,
  );
  const clock = new ManualClock();
  const database = join(workspace, "evidence.sqlite");
  let runtime = new Runtime({ database, workspace, clock });
  const probe = defineProbe({
    name: "quiet",
    description: "Controlled",
    params: z.object({}),
    policy: { everyMs: 1_000, maxAttempts: 2, timeoutMs: 1_000 },
    async run() {
      throw new Error("Manual clock must not evaluate probes");
    },
  });
  const open = () => runtime.start([identity(), work({ probes: [probe] }), workflows()]);
  await open();
  try {
    for (const target of ["pending", "waiting", "exhausted", "cleared", "dismissed"] as const) {
      const started = viewSchema.parse(
        await runtime.invoke(
          "workflow",
          { command: "start", source: "evidence.ts", input: { target } },
          { identity: "smoke" },
        ),
      );
      if (target === "pending") {
        assert.equal(
          started.tasks.length,
          1,
          "Start must deliver the initial mapped pending status",
        );
        assert.equal(started.gates.length, 0);
        assert.equal(started.history.length, 1);
      }
      const gate = z
        .string()
        .parse(target === "pending" ? started.history[0]?.id : started.gates[0]?.id);
      const store = workStore(runtime.context);
      const apply = (command: GateCommand) => store.gates.apply(gate, command);
      const at = new Date(clock.now()).toISOString();
      const failed = (attempt: number): GateCommand => ({
        type: "attempt",
        round: 1,
        attempt,
        at,
        by: "probe",
        result: {
          outcome: "failed",
          at,
          message: "not yet",
          evidence: { nested: { nullable: null }, attempt },
        },
      });
      if (target === "waiting" || target === "exhausted") {
        apply(failed(1));
        if (target === "exhausted") apply(failed(2));
      } else if (target === "cleared") {
        apply({
          type: "attempt",
          round: 1,
          attempt: 1,
          at,
          by: "probe",
          result: {
            outcome: "passed",
            message: "verified",
            evidence: { url: "local://proof", nullable: null },
          },
        });
      } else if (target === "dismissed") {
        apply({ type: "dismiss", at, by: "reviewer", reason: "Waived with findings" });
      }
      const status = workStore(runtime.context).gates.get(gate).status;
      if (target === "pending") {
        await runtime.stop();
        runtime = new Runtime({ database, workspace, clock });
        await open();
        assert.deepEqual(
          viewSchema.parse(
            await runtime.invoke("workflow", { command: "show", id: started.run.id }),
          ),
          started,
          "Restart must not advance or duplicate an already delivered initial status",
        );
      }
      await runtime.drain();
      const shown = viewSchema.parse(
        await runtime.invoke("workflow", { command: "show", id: started.run.id }),
      );
      const task = z.string().parse(shown.tasks[0]?.id);
      const expected = { gate, status };
      assert.deepEqual(runtime.graph.show(task).attributes["consumer/evidence"], expected);
      assert.deepEqual(runtime.graph.show(gate).attributes[attrs.result], {
        choice: status.status,
        data: expected,
      });
      assert.deepEqual(runtime.errors, []);
    }
    await Bun.write(
      join(workspace, "initial-mapping.ts"),
      `
import { existsSync } from "node:fs";
import { assign, setup } from "xstate";
import { z } from "zod";
export const inputSchema = z.object({ via: z.enum(["start", "task", "event"]), marker: z.string().nullable().default(null) });
export const commandSchemas = { next: z.object({}) };
export function runBrief() { return { title: "Initial mapping chain", description: "Deliver only after publication commits" }; }
const remember = assign({ received: ({ context, event }) => [...context.received, event.data] });
export const machine = setup({}).createMachine({
  context: ({ input }) => ({ ...input, received: [] }), initial: "choose",
  states: {
    choose: { always: [
      { guard: ({ context }) => context.via === "task", target: "worker" },
      { guard: ({ context }) => context.via === "event", target: "waiting" },
      { target: "first" },
    ] },
    worker: { meta: { title: "Enter gates", commands: { next: "NEXT" }, task: () => ({ instructions: "Publish the mapped gates" }) }, on: { NEXT: "first" } },
    waiting: { meta: { title: "Trigger chain", gate: () => ({ probe: "quiet", params: {} }), on: { cleared: "CLEARED" } }, on: { CLEARED: "first" } },
    first: { meta: { title: "First pending", gate: () => ({ probe: "quiet", params: {} }), on: { pending: "FIRST" } }, on: { FIRST: { target: "second", actions: remember } } },
    second: { meta: { title: "Second pending", gate: () => ({ probe: "quiet", params: {} }), on: { pending: "SECOND" } }, on: { SECOND: { target: "record", actions: remember } } },
    record: { meta: { title: "Chain recorded", commands: { next: "DONE" }, task: ({ context }) => {
      if (context.marker !== null && !existsSync(context.marker)) throw new Error("gate render rejected");
      return { instructions: "Inspect both committed gates", attributes: { "consumer/chain": context.received } };
    } }, on: { DONE: "done" } },
    done: { type: "final" },
  },
});
`,
    );
    const chains: z.infer<typeof viewSchema>[] = [];
    for (const via of ["start", "task", "event"] as const) {
      let chain = viewSchema.parse(
        await runtime.invoke(
          "workflow",
          { command: "start", source: "initial-mapping.ts", input: { via } },
          { identity: "smoke" },
        ),
      );
      if (via === "task")
        chain = viewSchema.parse(
          await runtime.invoke(
            "workflow",
            { command: "complete", id: z.string().parse(chain.tasks[0]?.id), choice: "next" },
            { identity: "smoke" },
          ),
        );
      if (via === "event") {
        workStore(runtime.context).gates.apply(z.string().parse(chain.gates[0]?.id), {
          type: "clear",
          at: new Date(clock.now()).toISOString(),
          by: "smoke",
          message: "Publish a pending chain inside the gate event queue",
        });
        await runtime.drain();
        chain = viewSchema.parse(
          await runtime.invoke("workflow", { command: "show", id: chain.run.id }),
        );
      }
      assert.equal(chain.gates.length, 0);
      assert.equal(chain.tasks.length, 1);
      assert.equal(chain.history.length, via === "start" ? 2 : 3);
      const pendingGates = chain.history.slice(-2).map(({ id }) => id);
      const evidence = pendingGates.map((gate) => ({
        gate,
        status: { status: "pending", round: 1 },
      }));
      for (const gate of pendingGates) {
        assert.equal(runtime.graph.show(gate).attributes[attrs.consumed], true);
        assert.deepEqual(runtime.graph.show(gate).attributes[attrs.result], {
          choice: "pending",
          data: { gate, status: { status: "pending", round: 1 } },
        });
      }
      assert.deepEqual(
        runtime.graph.show(z.string().parse(chain.tasks[0]?.id)).attributes["consumer/chain"],
        evidence,
      );
      assert.equal(runtime.graph.show(chain.run.id).attributes[attrs.publication], null);
      await runtime.drain();
      assert.deepEqual(
        viewSchema.parse(await runtime.invoke("workflow", { command: "show", id: chain.run.id })),
        chain,
        "Queued notifications must not consume either gate twice",
      );
      chains.push(chain);
    }
    for (const retry of ["show", "complete"] as const) {
      const marker = join(workspace, `mapped-retry-${retry}.flag`);
      const started = viewSchema.parse(
        await runtime.invoke(
          "workflow",
          { command: "start", source: "initial-mapping.ts", input: { via: "task", marker } },
          { identity: "smoke" },
        ),
      );
      const completion = {
        command: "complete",
        id: z.string().parse(started.tasks[0]?.id),
        choice: "next",
      };
      await assert.rejects(
        runtime.invoke("workflow", completion, { identity: "smoke" }),
        /gate render rejected/u,
      );
      assert.equal(runtime.graph.show(completion.id).attributes[attrs.consumed], true);
      assert.equal(runtime.graph.show(started.run.id).attributes[attrs.publication], null);
      await Bun.write(marker, "Renderer available");
      const recovered = viewSchema.parse(
        await runtime.invoke(
          "workflow",
          retry === "show" ? { command: "show", id: started.run.id } : completion,
          { identity: "smoke" },
        ),
      );
      assert.equal(recovered.tasks.length, 1, `${retry} must retry failed mapped gate delivery`);
      assert.equal(recovered.gates.length, 0);
      assert.equal(recovered.history.length, 3, "Each worker/gate is consumed exactly once");
      chains.push(recovered);
    }
    const marker = join(workspace, "mapped-start-retry.flag");
    let failedRun: string | undefined;
    await assert.rejects(
      runtime.invoke(
        "workflow",
        { command: "start", source: "initial-mapping.ts", input: { via: "start", marker } },
        { identity: "smoke" },
      ),
      (error: unknown) => {
        const failure = z
          .object({
            code: z.literal("workflow-publication"),
            message: z.string(),
            details: z.object({ run: z.string() }),
          })
          .parse(error);
        failedRun = failure.details.run;
        assert.ok(failure.message.includes(`Workflow ${failedRun} checkpoint retained`));
        assert.match(failure.message, /status delivery pending: gate render rejected/u);
        return true;
      },
    );
    await Bun.write(marker, "Renderer available");
    const recoveredStart = viewSchema.parse(
      await runtime.invoke("workflow", { command: "show", id: z.string().parse(failedRun) }),
    );
    assert.equal(recoveredStart.tasks.length, 1);
    assert.equal(recoveredStart.gates.length, 0);
    assert.equal(recoveredStart.history.length, 2);
    chains.push(recoveredStart);
    await runtime.stop();
    runtime = new Runtime({ database, workspace, clock });
    await open();
    await runtime.drain();
    for (const chain of chains)
      assert.deepEqual(
        viewSchema.parse(await runtime.invoke("workflow", { command: "show", id: chain.run.id })),
        chain,
        "Start, task and event publication must remain unchanged by activation replay",
      );
    assert.deepEqual(runtime.errors, []);
    await copyWorkflowExample(workspace, "gate-escalation");
    const retrying = viewSchema.parse(
      await runtime.invoke(
        "workflow",
        {
          command: "start",
          name: "gate-escalation",
          input: { flag: join(workspace, "absent.flag") },
        },
        { identity: "smoke" },
      ),
    );
    const retryGate = z.string().parse(retrying.gates[0]?.id);
    const firstIdentity = runtime.graph.show(retryGate).attributes[attrs.identity];
    const store = workStore(runtime.context);
    for (const attempt of [1, 2])
      store.gates.apply(retryGate, {
        type: "attempt",
        round: 1,
        attempt,
        at: new Date(clock.now()).toISOString(),
        by: "probe",
        result: {
          outcome: "failed",
          at: new Date(clock.now()).toISOString(),
          message: "Absent flag",
          evidence: { path: null },
        },
      });
    await runtime.drain();
    const investigation = viewSchema.parse(
      await runtime.invoke("workflow", { command: "show", id: retrying.run.id }),
    );
    const investigator = z.string().parse(investigation.tasks[0]?.id);
    await runtime.invoke(
      "workflow",
      { command: "complete", id: investigator, choice: "retry" },
      { identity: "smoke" },
    );
    const retried = viewSchema.parse(
      await runtime.invoke("workflow", { command: "show", id: retrying.run.id }),
    );
    assert.equal(retried.gates[0]?.id, retryGate);
    assert.notEqual(runtime.graph.show(retryGate).attributes[attrs.identity], firstIdentity);
    assert.equal(runtime.graph.show(retryGate).attributes[attrs.number], 2);
    assert.deepEqual(store.gates.get(retryGate).status, { status: "pending", round: 2 });
    await runtime.drain();
    assert.deepEqual(runtime.errors, []);
    await Bun.write(
      join(workspace, "parallel-evidence.ts"),
      `
import { setup } from "xstate";
import { z } from "zod";
export const inputSchema = z.object({});
export const commandSchemas = { next: z.object({}) };
export function runBrief() { return { title: "Concurrent gate", description: "Do not lose a gate event during publication" }; }
export const machine = setup({}).createMachine({ type: "parallel", states: {
  worker: { initial: "first", states: {
    first: { meta: { title: "First", commands: { next: "NEXT" }, task: () => ({ instructions: "Advance" }) }, on: { NEXT: "second" } },
    second: { meta: { title: "Second", commands: { next: "END" }, task: () => ({ instructions: "Wait for prerequisite" }), gates: () => [{ title: "Slow preparation", probe: "slow", params: {} }] }, on: { END: "done" } },
    done: { type: "final" },
  } },
  gate: { initial: "wait", states: {
    wait: { meta: { title: "Concurrent gate", gate: () => ({ probe: "quiet", params: {} }), on: { cleared: "CLEARED" } }, on: { CLEARED: "done" } },
    done: { type: "final" },
  } },
} });
`,
    );
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let rejectPreparation = false;
    gateProbes(runtime.context).provide(async (key) => {
      if (key !== "slow") return;
      if (rejectPreparation) {
        rejectPreparation = false;
        throw new Error("Probe temporarily unavailable");
      }
      entered.resolve();
      await release.promise;
      return { ...probe, name: "slow" };
    });
    const parallel = viewSchema.parse(
      await runtime.invoke(
        "workflow",
        { command: "start", source: "parallel-evidence.ts" },
        { identity: "smoke" },
      ),
    );
    const workerId = z.string().parse(parallel.tasks[0]?.id);
    const gateId = z.string().parse(parallel.gates[0]?.id);
    const gateIdentity = runtime.graph.show(gateId).attributes[attrs.identity];
    const advancing = runtime.invoke(
      "workflow",
      { command: "complete", id: workerId, choice: "next" },
      { identity: "smoke" },
    );
    await entered.promise;
    workStore(runtime.context).gates.apply(gateId, {
      type: "clear",
      at: new Date(clock.now()).toISOString(),
      by: "smoke",
      message: "During publication",
    });
    release.resolve();
    await advancing;
    await runtime.drain();
    assert.equal(runtime.graph.show(gateId).attributes[attrs.consumed], true);
    assert.equal(runtime.graph.show(gateId).attributes[attrs.identity], gateIdentity);
    const parallelAfter = viewSchema.parse(
      await runtime.invoke("workflow", { command: "show", id: parallel.run.id }),
    );
    assert.equal(parallelAfter.tasks.length, 1);
    assert.equal(parallelAfter.gates.length, 0);
    assert.equal(parallelAfter.history.length, 2);
    assert.deepEqual(runtime.errors, []);
    const retryPublication = viewSchema.parse(
      await runtime.invoke(
        "workflow",
        { command: "start", source: "parallel-evidence.ts" },
        { identity: "smoke" },
      ),
    );
    const retryTask = z.string().parse(retryPublication.tasks[0]?.id);
    rejectPreparation = true;
    await assert.rejects(
      runtime.invoke(
        "workflow",
        { command: "complete", id: retryTask, choice: "next" },
        { identity: "smoke" },
      ),
      new RegExp(
        `Workflow ${retryPublication.run.id} checkpoint retained; publication pending`,
        "u",
      ),
    );
    assert.equal(runtime.graph.show(retryTask).attributes[attrs.consumed], true);
    const resumed = viewSchema.parse(
      await runtime.invoke("workflow", { command: "show", id: retryPublication.run.id }),
    );
    assert.equal(resumed.tasks.length, 1);
    assert.notEqual(resumed.tasks[0]?.id, retryTask);
    assert.equal(runtime.graph.show(retryPublication.run.id).attributes[attrs.publication], null);
    assert.deepEqual(runtime.errors, []);
  } finally {
    await runtime.stop();
  }
}
