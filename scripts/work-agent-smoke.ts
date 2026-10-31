// Run: bun scripts/work-agent-smoke.ts — deterministic SQLite liveness checks plus a packaged CLI boundary smoke.
// oxlint-disable import/max-dependencies -- This standalone smoke composes the selected extensions.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ManualClock,
  Runtime,
  type Extension,
  type ProcessFact,
  type Processes,
} from "@botlake/core";
import { agentAttributes, agentFlags, agents, provider } from "@botlake/extension-agents";
import { configureFlags } from "@botlake/extension-flags";
import { identity } from "@botlake/extension-identity";
import { work } from "@botlake/extension-work";
import { workAgentAttributes, workAgents } from "@botlake/extension-work-agents";
import { z } from "zod";

import { system } from "../tests/blackbox/fixtures/system.ts";

const identifier = z.object({ id: z.string() });
const assignment = z.object({ id: z.string(), assignee: z.string() });
const claim = z.object({ assignment });
const native = z.object({ identity: z.string(), runId: z.string() });
const taskDetail = z.object({
  item: z.object({
    kind: z.literal("task"),
    state: z.literal("open"),
    description: z.string(),
    notes: z.string().nullable(),
    acceptanceCriteria: z.array(z.object({ condition: z.string() })),
    assignment: assignment.nullable(),
  }),
  prerequisites: z.array(z.object({ id: z.string() })),
  history: z
    .object({
      assignments: z.array(
        z.object({ id: z.string(), release: z.object({ reason: z.string() }).nullable() }),
      ),
    })
    .optional(),
});
const binding = z.object({
  task: z.string(),
  assignment: z.string(),
  run: z.string(),
  invocation: z.string().nullable(),
  identity: z.string(),
  heartbeatAt: z.number(),
  status: z.enum(["active", "released", "superseded"]),
});

function nativeObservationGate() {
  let paused:
    | { observed: PromiseWithResolvers<void>; release: PromiseWithResolvers<void> }
    | undefined;

  function extension(): Extension {
    return {
      name: "smoke-native-observation-gate",
      activate(ctx) {
        ctx.subscribe(async (event) => {
          const current = paused;
          if (
            current === undefined ||
            !event.changes.some(
              (change) =>
                change.kind === "node" && change.after?.attributes[agentAttributes.run] === true,
            )
          )
            return;
          current.observed.resolve();
          await current.release.promise;
        });
      },
    };
  }

  function pause(): Promise<void> {
    assert.equal(paused, undefined, "Native observation gate is already paused");
    paused = { observed: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
    return paused.observed.promise;
  }

  function resume(): void {
    const current = paused;
    assert.ok(current !== undefined, "Native observation gate is not paused");
    paused = undefined;
    current.release.resolve();
  }

  return { extension, pause, resume };
}

const noProcesses: Processes = {
  listOwned: async () => [],
  launch: unavailable,
  get: unavailable,
  cancel: unavailable,
  acknowledge: unavailable,
};

async function unavailable(): Promise<never> {
  throw new Error("This smoke must not execute a managed process");
}

function currentBinding(runtime: Runtime, task: string): z.output<typeof binding> {
  const node = runtime.graph
    .all({ lean: false })
    .find(
      (entry) =>
        entry.attributes[workAgentAttributes.binding] === true && bindingOf(entry).task === task,
    );
  assert.ok(node !== undefined, `Missing binding for ${task}`);
  return bindingOf(node);
}

function hasBinding(runtime: Runtime, task: string): boolean {
  return runtime.graph
    .all({ lean: false })
    .some(
      (entry) =>
        entry.attributes[workAgentAttributes.binding] === true && bindingOf(entry).task === task,
    );
}

function bindingOf(node: { attributes: Record<string, unknown> }): z.output<typeof binding> {
  return binding.parse(JSON.parse(z.string().parse(node.attributes[workAgentAttributes.value])));
}

async function directRuntime(
  database: string,
  clock: ManualClock,
  gate: ReturnType<typeof nativeObservationGate>,
): Promise<Runtime> {
  const runtime = new Runtime({
    database,
    workspace: process.cwd(),
    clock,
    processes: noProcesses,
  });
  const liveness = workAgents({ checkIntervalMs: 1000 });
  await runtime.start([
    configureFlags([]),
    identity(),
    agents(),
    work(),
    gate.extension(),
    { ...liveness, requires: [...(liveness.requires ?? []), "smoke-native-observation-gate"] },
  ]);
  return runtime;
}

async function createTask(
  runtime: Runtime,
  title: string,
  fields: Record<string, unknown> = {},
): Promise<string> {
  return identifier.parse(
    await runtime.invoke("work", { command: "create", title, by: "smoke", ...fields }),
  ).id;
}

async function registerNative(
  runtime: Runtime,
  session: string,
  audience: "agent" | "human",
  event: "agent-start" | "session-end" = "agent-start",
): Promise<z.output<typeof native>> {
  return native.parse(
    await runtime.invoke("agent", {
      command: "native",
      provider: "codex",
      nativeSessionId: session,
      cwd: process.cwd(),
      audience,
      event,
    }),
  );
}

async function directPhase(): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), "botlake-work-agent-smoke-"));
  const database = join(dir, "lake.sqlite");
  const clock = new ManualClock();
  const gate = nativeObservationGate();
  let runtime: Runtime | undefined;
  try {
    runtime = await directRuntime(database, clock, gate);
    const agent = await registerNative(runtime, "direct-agent", "agent");
    const successor = await registerNative(runtime, "direct-successor", "agent");

    const humanTask = await createTask(runtime, "Human checkpoint stays unbound", {
      assignee: agent.identity,
      audience: "HITL",
    });
    assert.equal(hasBinding(runtime, humanTask), false);

    const automatic = await createTask(runtime, "Automatically bind native assignment");
    const automaticClaim = claim.parse(
      await runtime.invoke("work", {
        command: "claim",
        id: automatic,
        assignee: agent.identity,
        by: agent.identity,
      }),
    ).assignment;
    assert.deepEqual(currentBinding(runtime, automatic), {
      task: automatic,
      assignment: automaticClaim.id,
      run: agent.runId,
      invocation: null,
      identity: agent.identity,
      heartbeatAt: clock.now(),
      status: "active",
    });

    const delayedEnd = gate.pause();
    try {
      await registerNative(runtime, "direct-agent", "agent", "session-end");
      await delayedEnd;
      await registerNative(runtime, "direct-agent", "agent");
    } finally {
      gate.resume();
      await runtime.drain();
    }
    assert.equal(
      currentBinding(runtime, automatic).status,
      "active",
      "A delayed native end cannot release a resumed session",
    );

    const wrongReference = await createTask(runtime, "Wrong run reference remains unbound");
    const wrongReferenceClaim = claim.parse(
      await runtime.invoke(
        "work",
        {
          command: "claim",
          id: wrongReference,
          assignee: successor.identity,
          by: successor.identity,
        },
        { env: { BL_RUN_REFERENCE: `${agent.runId}:wrong-invocation` } },
      ),
    ).assignment;
    assert.equal(hasBinding(runtime, wrongReference), false);
    await runtime.invoke("work-agent", {
      command: "bind",
      task: wrongReference,
      run: successor.runId,
      assignment: wrongReferenceClaim.id,
    });
    assert.equal(currentBinding(runtime, wrongReference).run, successor.runId);

    const unmatched = await createTask(runtime, "Unknown assignee remains unbound");
    await runtime.invoke("work", {
      command: "claim",
      id: unmatched,
      assignee: "unregistered-agent",
      by: "unregistered-agent",
    });
    assert.equal(hasBinding(runtime, unmatched), false);

    const prerequisite = await createTask(runtime, "Prerequisite");
    await runtime.invoke("work", { command: "close", id: prerequisite, by: "smoke" });

    const observed = await createTask(runtime, "Observe at expiry", {
      description: "keep this brief",
      notes: "keep this finding",
      acceptanceCriteria: ["keep this criterion"],
      prerequisites: [prerequisite],
    });
    const observedClaim = claim.parse(
      await runtime.invoke("work", {
        command: "claim",
        id: observed,
        assignee: agent.identity,
        by: agent.identity,
      }),
    ).assignment;
    await runtime.invoke("work-agent", {
      command: "bind",
      task: observed,
      run: agent.runId,
      assignment: observedClaim.id,
    });
    await runtime.invoke(
      "work-agent",
      { command: "heartbeat", task: observed, run: agent.runId, assignment: observedClaim.id },
      { env: { BL_ACTOR: agent.identity } },
    );
    await assert.rejects(
      runtime.invoke("work-agent", {
        command: "heartbeat",
        task: observed,
        run: agent.runId,
        assignment: observedClaim.id,
        byIdentity: "another-identity",
      }),
      /attribution/u,
    );
    await runtime.invoke(
      "work-agent",
      {
        command: "heartbeat",
        task: observed,
        run: agent.runId,
        assignment: observedClaim.id,
        byIdentity: agent.identity,
      },
      { env: { BL_ACTOR: "another-identity" } },
    );
    assert.equal(currentBinding(runtime, observed).invocation, null);

    await runtime.stop();
    runtime = await directRuntime(database, clock, gate);
    const beforeObservation = currentBinding(runtime, observed);
    const observedBinding = bindingNode(runtime, observed);
    const oldWake = runtime.scheduler
      .pending()
      .find((wake) => wake.key === `work-agents/${observedBinding}`);
    assert.ok(oldWake !== undefined, "Restart did not restore the durable heartbeat wake");
    assert.equal(oldWake.at, beforeObservation.heartbeatAt + 1000);

    // Hold the subscriber behind a real native graph event; expiry must reread persisted state itself.
    clock.advance(beforeObservation.heartbeatAt + 1);
    const queuedObservation = gate.pause();
    const observationRegistration = registerNative(runtime, "direct-agent", "agent");
    await queuedObservation;
    clock.advance(oldWake.at);
    await runtime.scheduler.drain();
    const refreshed = currentBinding(runtime, observed);
    try {
      assert.ok(refreshed.heartbeatAt > beforeObservation.heartbeatAt);
      const observedDetail = taskDetail.parse(
        await runtime.invoke("work", { command: "show", id: observed, history: true }),
      );
      assert.equal(
        observedDetail.item.assignment?.id,
        observedClaim.id,
        JSON.stringify({ beforeObservation, refreshed, observedDetail }),
      );
    } finally {
      gate.resume();
      await observationRegistration;
      await runtime.drain();
    }

    await runtime.invoke("work", {
      command: "release",
      id: observed,
      assignmentId: observedClaim.id,
      reason: "handoff",
      by: "smoke",
    });
    const newClaim = claim.parse(
      await runtime.invoke("work", {
        command: "claim",
        id: observed,
        assignee: successor.identity,
        by: successor.identity,
      }),
    ).assignment;
    const staleWake = runtime.scheduler
      .pending()
      .find((wake) => wake.key === `work-agents/${observedBinding}`);
    assert.ok(
      staleWake !== undefined,
      "Expected the old binding wake to remain fenced by its assignment token",
    );
    clock.advance(staleWake.at);
    await runtime.drain();
    assert.equal(
      taskDetail.parse(await runtime.invoke("work", { command: "show", id: observed })).item
        .assignment?.id,
      newClaim.id,
    );
    assert.equal(currentBinding(runtime, observed).status, "superseded");

    const expiring = await createTask(runtime, "Release only the matching token", {
      description: "retained description",
      notes: "retained notes",
      acceptanceCriteria: ["retained criterion"],
      prerequisites: [prerequisite],
    });
    const expiringClaim = claim.parse(
      await runtime.invoke("work", {
        command: "claim",
        id: expiring,
        assignee: agent.identity,
        by: agent.identity,
      }),
    ).assignment;
    await runtime.invoke("work-agent", {
      command: "bind",
      task: expiring,
      run: agent.runId,
      assignment: expiringClaim.id,
    });
    const expiringBinding = bindingNode(runtime, expiring);
    const expiryWake = runtime.scheduler
      .pending()
      .find((wake) => wake.key === `work-agents/${expiringBinding}`);
    assert.ok(expiryWake !== undefined, "Missing liveness wake");
    clock.advance(expiryWake.at);
    await runtime.drain();
    assert.equal(
      taskDetail.parse(await runtime.invoke("work", { command: "show", id: expiring })).item
        .assignment?.id,
      expiringClaim.id,
      "A quiet native session has not supplied evidence of exit",
    );
    const queuedEnd = gate.pause();
    const endRegistration = registerNative(runtime, "direct-agent", "agent", "session-end");
    await queuedEnd;
    const recheck = runtime.scheduler
      .pending()
      .find((wake) => wake.key === `work-agents/${expiringBinding}`);
    assert.ok(recheck !== undefined, "An uncertain session should remain scheduled for recheck");
    clock.advance(recheck.at);
    try {
      await runtime.scheduler.drain();
    } finally {
      gate.resume();
      await endRegistration;
      await runtime.drain();
    }
    const released = taskDetail.parse(
      await runtime.invoke("work", { command: "show", id: expiring, history: true }),
    );
    assert.equal(released.item.assignment, null);
    assert.equal(released.item.description, "retained description");
    assert.equal(released.item.notes, "retained notes");
    assert.equal(released.item.acceptanceCriteria[0]?.condition, "retained criterion");
    assert.deepEqual(
      released.prerequisites.map(({ id }) => id),
      [prerequisite],
    );
    assert.equal(released.history?.assignments[0]?.release?.reason, "native agent session ended");

    const endedTask = await createTask(runtime, "Cannot bind an ended session", {
      assignee: agent.identity,
    });
    const endedAssignment = taskDetail.parse(
      await runtime.invoke("work", { command: "show", id: endedTask }),
    ).item.assignment;
    assert.ok(endedAssignment !== null);
    await assert.rejects(
      runtime.invoke("work-agent", {
        command: "bind",
        task: endedTask,
        run: agent.runId,
        assignment: endedAssignment.id,
      }),
      /has not ended/u,
    );
    assert.equal(
      taskDetail.parse(await runtime.invoke("work", { command: "show", id: endedTask })).item
        .assignment?.id,
      endedAssignment.id,
      "Rejected ended-session binding must leave assignment intact",
    );

    const hitl = await createTask(runtime, "Human checkpoint", {
      audience: "HITL",
      assignee: agent.identity,
    });
    const hitlAssignment = taskDetail.parse(
      await runtime.invoke("work", { command: "show", id: hitl }),
    ).item.assignment;
    assert.ok(hitlAssignment !== null);
    await assert.rejects(
      runtime.invoke("work-agent", {
        command: "bind",
        task: hitl,
        run: successor.runId,
        assignment: hitlAssignment.id,
      }),
      /AFK/u,
    );

    const human = await registerNative(runtime, "direct-human", "human");
    const humanAudience = await createTask(runtime, "Human-audience native", {
      assignee: human.identity,
    });
    const humanAssignment = taskDetail.parse(
      await runtime.invoke("work", { command: "show", id: humanAudience }),
    ).item.assignment;
    assert.ok(humanAssignment !== null);
    await assert.rejects(
      runtime.invoke("work-agent", {
        command: "bind",
        task: humanAudience,
        run: human.runId,
        assignment: humanAssignment.id,
      }),
      /agent-audience/u,
    );

    const untouched = await createTask(runtime, "Unbound human", {
      audience: "HITL",
      assignee: "human-owner",
    });
    assert.equal(
      taskDetail.parse(await runtime.invoke("work", { command: "show", id: untouched })).item
        .assignment?.assignee,
      "human-owner",
    );
    assert.deepEqual(runtime.errors, []);
    return [
      "automatic native binding and exact-reference rejection",
      "unmatched assignment remains valid; manual binding remains available",
      "SQLite restart wake",
      "null external heartbeat",
      "quiet native ownership retained; session-end reread releases",
      "fenced release",
      "audience guards",
    ];
  } finally {
    if (runtime !== undefined) await runtime.stop();
    await rm(dir, { recursive: true, force: true });
  }
}

async function managedPhase(): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), "botlake-work-agent-managed-"));
  const clock = new ManualClock();
  const gate = nativeObservationGate();
  let succeeds = true;
  let preparationFails = false;
  let launchFails = false;
  let sessionId = "managed-smoke";
  let fact: ProcessFact | undefined;
  const processes: Processes = {
    async launch(spec) {
      fact = {
        handle: "managed-process",
        owner: spec.owner,
        key: spec.key,
        phase: "running",
        output: { stdout_ref: join(dir, "stdout"), stderr_ref: join(dir, "stderr") },
        ...(launchFails
          ? { phase: "terminal", launch_failure: { message: "fixture launch failure" } }
          : {}),
      };
      return fact;
    },
    async listOwned() {
      return fact === undefined ? [] : [fact];
    },
    async get() {
      assert.ok(fact !== undefined);
      return fact;
    },
    cancel: unavailable,
    acknowledge: async () => {},
  };
  await Bun.write(join(dir, "stdout"), "");
  await Bun.write(join(dir, "stderr"), "");
  const runtime = new Runtime({
    database: join(dir, "lake.sqlite"),
    workspace: process.cwd(),
    clock,
    processes,
  });
  try {
    const codex = provider("codex");
    await runtime.start([
      configureFlags([[agentFlags.codex, true]]),
      identity(),
      agents({
        providers: [
          {
            ...codex,
            prepare: () => {
              if (preparationFails) throw new Error("fixture preparation failure");
              return { command: ["fixture-agent"], stdin: "", env: {} };
            },
            finish: () => ({
              success: succeeds,
              result: succeeds ? "done" : null,
              error: succeeds ? null : "fixture failure",
              sessionId,
            }),
          },
        ],
        aliases: { worker: { provider: "codex" } },
      }),
      work(),
      gate.extension(),
      {
        ...workAgents({ checkIntervalMs: 1000 }),
        requires: ["work", "agents", "identity", "smoke-native-observation-gate"],
      },
    ]);
    async function beginManagedTask(session: string, bind = true, automatic = false) {
      sessionId = session;
      const started = identifier.parse(
        await runtime.invoke("agent", {
          command: "start",
          seat: "worker",
          cwd: process.cwd(),
          prompt: "Wait quietly",
        }),
      );
      const row = z
        .object({ attributes: z.record(z.string(), z.json()) })
        .parse(await runtime.invoke("agent", { command: "show", id: started.id }));
      const invocation = z.string().parse(row.attributes[agentAttributes.invocation]);
      const registered = native.parse(
        await runtime.invoke("agent", {
          command: "native",
          provider: "codex",
          nativeSessionId: session,
          cwd: process.cwd(),
          event: "agent-start",
          runId: started.id,
          invocation,
        }),
      );
      const task = await createTask(runtime, session);
      const assigned = claim.parse(
        await runtime.invoke(
          "work",
          {
            command: "claim",
            id: task,
            assignee: registered.identity,
            by: registered.identity,
          },
          {
            env: automatic
              ? {
                  BL_RUN_REFERENCE: `${started.id}:${invocation}`,
                }
              : {},
          },
        ),
      ).assignment;
      if (bind)
        await runtime.invoke("work-agent", {
          command: "bind",
          task,
          run: started.id,
          assignment: assigned.id,
        });
      await runtime.drain();
      return {
        task,
        assigned,
        runId: started.id,
        identity: registered.identity,
        invocation,
      };
    }
    for (const failure of ["preparation", "launch"]) {
      preparationFails = failure === "preparation";
      launchFails = failure === "launch";
      const lifecycleStatus = z.object({
        id: z.string(),
        state: z.string(),
        substatus: z.string(),
        settled: z.boolean(),
      });
      const failed = lifecycleStatus.parse(
        await runtime.invoke("agent", {
          command: "start",
          seat: "worker",
          cwd: process.cwd(),
          prompt: "Fail before execution",
        }),
      );
      assert.equal(failed.state, "failed");
      assert.equal(failed.substatus, failure === "preparation" ? "reconciliation" : "launch");
      assert.equal(failed.settled, true);
      preparationFails = false;
      launchFails = false;
      assert.deepEqual(
        lifecycleStatus.parse(await runtime.invoke("agent", { command: "retry", id: failed.id })),
        { id: failed.id, state: "running", substatus: "pending", settled: false },
      );
      assert.ok(fact !== undefined);
      fact = { ...fact, phase: "terminal", exit: { code: 0, signal: null } };
      await runtime.invoke("agent", { command: "reconcile" });
    }
    const managed = await beginManagedTask("managed-smoke", false, true);
    const { task, assigned } = managed;
    assert.equal(
      currentBinding(runtime, task).run,
      managed.runId,
      "Exact managed reference binds without a manual command",
    );
    const otherIdentity = await registerNative(runtime, "coordinator-target", "agent");
    const reserved = await createTask(runtime, "Coordinator assigns someone else");
    await runtime.invoke(
      "work",
      { command: "claim", id: reserved, assignee: otherIdentity.identity, by: managed.identity },
      { env: { BL_RUN_REFERENCE: `${managed.runId}:${managed.invocation}` } },
    );
    assert.equal(hasBinding(runtime, reserved), false, "Issuer run must not bind another assignee");
    clock.advance(60_000);
    await runtime.drain();
    assert.equal(
      taskDetail.parse(
        await runtime.invoke("work", {
          command: "show",
          id: task,
        }),
      ).item.assignment?.id,
      assigned.id,
      "A quiet managed process must retain ownership",
    );
    assert.ok(fact !== undefined);
    fact = { ...fact, phase: "terminal", exit: { code: 0, signal: null } };
    await runtime.invoke("agent", { command: "reconcile" });
    await runtime.drain();
    assert.equal(
      taskDetail.parse(
        await runtime.invoke("work", {
          command: "show",
          id: task,
        }),
      ).item.assignment,
      null,
      "Confirmed managed exit releases ownership without an exit hook",
    );

    // A committed settlement remains valid even if retry replaces the current run before delivery.
    succeeds = false;
    const retrying = await beginManagedTask("managed-retry");
    assert.ok(fact !== undefined);
    fact = { ...fact, phase: "terminal", exit: { code: 1, signal: null } };
    const queuedSettlement = gate.pause();
    try {
      await runtime.invoke("agent", { command: "reconcile" });
      await queuedSettlement;
      await runtime.invoke("agent", { command: "retry", id: retrying.runId });
    } finally {
      gate.resume();
    }
    await runtime.drain();
    assert.equal(
      taskDetail.parse(
        await runtime.invoke("work", {
          command: "show",
          id: retrying.task,
        }),
      ).item.assignment,
      null,
      "Retry must not erase a queued settlement's release evidence",
    );
    assert.equal(currentBinding(runtime, retrying.task).status, "released");

    // The retried invocation can acquire a fresh token; the previous binding cannot strand it.
    const retriedRow = z
      .object({ attributes: z.record(z.string(), z.json()) })
      .parse(await runtime.invoke("agent", { command: "show", id: retrying.runId }));
    assert.notEqual(retriedRow.attributes[agentAttributes.invocation], retrying.invocation);
    await runtime.invoke("agent", {
      command: "native",
      provider: "codex",
      nativeSessionId: sessionId,
      cwd: process.cwd(),
      event: "agent-start",
      runId: retrying.runId,
      invocation: retriedRow.attributes[agentAttributes.invocation],
    });
    const retriedClaim = claim.parse(
      await runtime.invoke("work", {
        command: "claim",
        id: retrying.task,
        assignee: retrying.identity,
        by: retrying.identity,
      }),
    ).assignment;
    await runtime.invoke("work-agent", {
      command: "bind",
      task: retrying.task,
      run: retrying.runId,
      assignment: retriedClaim.id,
    });
    succeeds = true;
    assert.ok(fact !== undefined);
    fact = { ...fact, phase: "terminal", exit: { code: 0, signal: null } };
    await runtime.invoke("agent", { command: "reconcile" });
    await runtime.drain();
    assert.equal(
      taskDetail.parse(
        await runtime.invoke("work", {
          command: "show",
          id: retrying.task,
        }),
      ).item.assignment,
      null,
    );

    // Cancellation may be observed before binding; uncertain custody must still be bindable.
    // Delayed V1 settlement must not release a fresh V2 assignment on the same run.
    succeeds = false;
    const rebound = await beginManagedTask("managed-rebound");
    assert.ok(fact !== undefined);
    fact = { ...fact, phase: "terminal", exit: { code: 1, signal: null } };
    const delayedSettlement = gate.pause();
    let freshAssignment: z.output<typeof assignment> | undefined;
    try {
      await runtime.invoke("agent", { command: "reconcile" });
      await delayedSettlement;
      await runtime.invoke("agent", { command: "retry", id: rebound.runId });
      await runtime.invoke("agent", {
        command: "native",
        provider: "codex",
        nativeSessionId: sessionId,
        cwd: process.cwd(),
        event: "agent-start",
        runId: rebound.runId,
        invocation: runtime.graph.show(rebound.runId).attributes[agentAttributes.invocation],
      });
      await runtime.invoke("work", {
        command: "release",
        id: rebound.task,
        assignmentId: rebound.assigned.id,
        reason: "handoff before queued settlement",
        by: rebound.identity,
      });
      freshAssignment = claim.parse(
        await runtime.invoke("work", {
          command: "claim",
          id: rebound.task,
          assignee: rebound.identity,
          by: rebound.identity,
        }),
      ).assignment;
      await runtime.invoke("work-agent", {
        command: "bind",
        task: rebound.task,
        run: rebound.runId,
        assignment: freshAssignment.id,
      });
    } finally {
      gate.resume();
    }
    await runtime.drain();
    assert.ok(freshAssignment !== undefined);
    assert.equal(
      taskDetail.parse(await runtime.invoke("work", { command: "show", id: rebound.task })).item
        .assignment?.id,
      freshAssignment.id,
      "An old settlement event cannot supersede the latest invocation's binding",
    );
    succeeds = true;
    assert.ok(fact !== undefined);
    fact = { ...fact, phase: "terminal", exit: { code: 0, signal: null } };
    await runtime.invoke("agent", { command: "reconcile" });
    await runtime.drain();

    const uncertain = await beginManagedTask("managed-uncertain", false);
    assert.ok(fact !== undefined);
    fact = { ...fact, phase: "terminal", cancellation: { reason: "cancel", stop: "uncertain" } };
    await runtime.invoke("agent", { command: "reconcile" });
    await assert.rejects(
      runtime.invoke("agent", { command: "retry", id: uncertain.runId }),
      /settled/u,
    );
    await runtime.invoke("work-agent", {
      command: "bind",
      task: uncertain.task,
      run: uncertain.runId,
      assignment: uncertain.assigned.id,
    });
    assert.equal(
      taskDetail.parse(
        await runtime.invoke("work", {
          command: "show",
          id: uncertain.task,
        }),
      ).item.assignment?.id,
      uncertain.assigned.id,
    );
    fact = {
      ...fact,
      cancellation: { reason: "cancel", stop: "observed" },
      exit: { code: 0, signal: null },
    };
    await runtime.invoke("agent", { command: "reconcile" });
    await runtime.drain();
    assert.equal(
      taskDetail.parse(
        await runtime.invoke("work", {
          command: "show",
          id: uncertain.task,
        }),
      ).item.assignment,
      null,
      "A late binding must release when previously uncertain custody settles",
    );
    const uncertainResult = z
      .object({ attributes: z.record(z.string(), z.json()) })
      .parse(await runtime.invoke("agent", { command: "show", id: uncertain.runId }));
    assert.equal(uncertainResult.attributes[agentAttributes.sessionConfirmed], true);
    assert.equal(uncertainResult.attributes[agentAttributes.error], undefined);

    const unconfirmed = await beginManagedTask("managed-unconfirmed");
    assert.ok(fact !== undefined);
    fact = { ...fact, phase: "terminal" };
    await runtime.invoke("agent", { command: "reconcile" });
    await runtime.drain();
    assert.equal(
      taskDetail.parse(await runtime.invoke("work", { command: "show", id: unconfirmed.task })).item
        .assignment?.id,
      unconfirmed.assigned.id,
      "Missing exit evidence must retain ownership",
    );
    await assert.rejects(
      runtime.invoke("agent", { command: "retry", id: unconfirmed.runId }),
      /settled/u,
    );
    fact = { ...fact, exit: { code: 0, signal: null } };
    await runtime.invoke("agent", { command: "reconcile" });
    await runtime.drain();
    assert.equal(
      taskDetail.parse(await runtime.invoke("work", { command: "show", id: unconfirmed.task })).item
        .assignment,
      null,
      "An observed exit must settle previously unconfirmed custody",
    );
    assert.deepEqual(runtime.errors, []);
    return [
      "quiet managed ownership",
      "exit release without hooks",
      "delayed settlement survives retry and rebinding",
      "uncertain custody can bind before settlement",
      "preparation and launch failures retry",
      "unconfirmed exit retains ownership and prevents retry",
    ];
  } finally {
    await runtime.stop();
    await rm(dir, { recursive: true, force: true });
  }
}

async function missedSettlementPhase(): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), "botlake-missed-settlement-"));
  const clock = new ManualClock(1000);
  let fact: ProcessFact | undefined;
  let runtime: Runtime | undefined;
  const stdout = join(dir, "stdout");
  const stderr = join(dir, "stderr");
  await Bun.write(stdout, "");
  await Bun.write(stderr, "");
  const processes: Processes = {
    ...noProcesses,
    listOwned: async () => (fact === undefined ? [] : [fact]),
    launch: async (spec) => {
      fact = {
        handle: spec.key,
        owner: spec.owner,
        key: spec.key,
        phase: "running",
        output: { stdout_ref: stdout, stderr_ref: stderr },
      };
      return fact;
    },
  };
  async function open(withBindings: boolean): Promise<Runtime> {
    const next = new Runtime({
      database: join(dir, "lake.sqlite"),
      clock,
      processes,
    });
    const codex = provider("codex");
    await next.start([
      configureFlags([[agentFlags.codex, true]]),
      identity(),
      agents({
        providers: [
          {
            ...codex,
            prepare: () => ({ command: ["fixture-agent"], stdin: "", env: {} }),
            finish: () => ({ success: false, result: null, error: "failed", sessionId: null }),
          },
        ],
      }),
      work(),
      ...(withBindings ? [workAgents({ checkIntervalMs: 1000 })] : []),
    ]);
    return next;
  }
  try {
    runtime = await open(true);
    const started = identifier.parse(
      await runtime.invoke("agent", {
        command: "start",
        seat: "codex",
        cwd: dir,
        prompt: "Original invocation",
      }),
    );
    const invocation = z
      .string()
      .parse(runtime.graph.show(started.id).attributes[agentAttributes.invocation]);
    const registered = native.parse(
      await runtime.invoke("agent", {
        command: "native",
        provider: "codex",
        nativeSessionId: "missed-settlement",
        cwd: dir,
        event: "agent-start",
        runId: started.id,
        invocation,
      }),
    );
    const task = await createTask(runtime, "Recover a missed settlement", {
      assignee: registered.identity,
    });
    const assigned = taskDetail.parse(await runtime.invoke("work", { command: "show", id: task }))
      .item.assignment;
    assert.ok(assigned !== null);
    await runtime.invoke("work-agent", {
      command: "bind",
      task,
      run: started.id,
      assignment: assigned.id,
    });
    await runtime.drain();
    await runtime.stop();

    // Settlement and retry occur while the optional Work Agents extension is absent.
    runtime = await open(false);
    assert.ok(fact !== undefined);
    fact = { ...fact, phase: "terminal", exit: { code: 1, signal: null } };
    await runtime.invoke("agent", { command: "reconcile" });
    await runtime.invoke("agent", { command: "retry", id: started.id });
    assert.notEqual(
      runtime.graph.show(started.id).attributes[agentAttributes.invocation],
      invocation,
    );
    assert.equal(
      taskDetail.parse(await runtime.invoke("work", { command: "show", id: task })).item.assignment
        ?.id,
      assigned.id,
    );
    await runtime.stop();

    runtime = await open(true);
    await runtime.drain();
    assert.equal(
      taskDetail.parse(await runtime.invoke("work", { command: "show", id: task })).item.assignment,
      null,
      "Restart must recover an old binding even after retry clears native identity",
    );
    assert.equal(currentBinding(runtime, task).status, "released");
    assert.deepEqual(runtime.errors, []);
    return ["missed settlement and retry recover on re-enable"];
  } finally {
    await runtime?.stop();
    await rm(dir, { recursive: true, force: true });
  }
}

function bindingNode(runtime: Runtime, task: string): string {
  const node = runtime.graph
    .all({ lean: false })
    .find(
      (entry) =>
        entry.attributes[workAgentAttributes.binding] === true && bindingOf(entry).task === task,
    );
  assert.ok(node !== undefined, `Missing binding node for ${task}`);
  return node.id;
}

async function packagedPhase(): Promise<string[]> {
  const host = await system();
  try {
    const workspace = await host.workspace("work-agent-smoke", [
      "@botlake/extension-batteries",
      "@botlake/extension-identity",
      "./flags.ts",
      "./agents.ts",
      "@botlake/extension-work",
      "./work-agents.ts",
    ]);
    const idle = join(workspace, "idle.ts");
    await Bun.write(idle, "setInterval(() => {}, 60_000);\n");
    await Bun.write(
      join(workspace, "flags.ts"),
      `import { agentFlags } from "@botlake/extension-agents";
import { configureFlags } from "@botlake/extension-flags";
export default configureFlags([[agentFlags.codex, true]]);\n`,
    );
    await Bun.write(
      join(workspace, "agents.ts"),
      `import { agents, provider } from "@botlake/extension-agents";
const codex = provider("codex");
export default agents({ providers: [{ ...codex, prepare() { return { command: ["bun", ${JSON.stringify(idle)}], stdin: "", env: {} }; } }], aliases: { worker: { provider: "codex" } } });\n`,
    );
    await Bun.write(
      join(workspace, "work-agents.ts"),
      `import { workAgents } from "@botlake/extension-work-agents";
export default workAgents({ checkIntervalMs: 60000 });\n`,
    );
    await host.botlake(["lake", "start", "--workspace", workspace]);

    const call = (operation: string, input: unknown, ok = true) =>
      host.bl(workspace, operation, input, ok);
    const prerequisite = identifier.parse(
      await call("work", { command: "create", title: "Prerequisite" }),
    ).id;
    await call("work", { command: "close", id: prerequisite, by: "smoke" });
    const target = identifier.parse(
      await call("work", {
        command: "create",
        title: "Managed task",
        acceptanceCriteria: ["Preserve criterion"],
        prerequisites: [prerequisite],
        by: "smoke",
      }),
    ).id;
    const human = identifier.parse(
      await call("work", {
        command: "create",
        title: "Human task",
        audience: "HITL",
        assignee: "human",
        by: "smoke",
      }),
    ).id;
    const started = z.object({ id: z.string() }).parse(
      await call("agent", {
        command: "start",
        seat: "worker",
        cwd: workspace,
        prompt: "idle",
        target,
      }),
    );
    const run = z
      .object({ attributes: z.record(z.string(), z.json()) })
      .parse(await call("agent", { command: "show", id: started.id }));
    const invocation = z.string().parse(run.attributes[agentAttributes.invocation]);
    const registered = native.parse(
      await call("agent", {
        command: "native",
        provider: "codex",
        cwd: workspace,
        nativeSessionId: "packaged-agent",
        runId: started.id,
        invocation,
        audience: "agent",
        event: "agent-start",
      }),
    );
    const assigned = claim.parse(
      await call("work", {
        command: "claim",
        id: target,
        assignee: registered.identity,
        by: registered.identity,
      }),
    ).assignment;
    await call("work-agent", {
      command: "bind",
      task: target,
      run: started.id,
      assignment: assigned.id,
    });
    await host.cli([
      "--workspace",
      workspace,
      "work-agent",
      "heartbeat",
      target,
      started.id,
      "--assignment",
      assigned.id,
      "--by-identity",
      registered.identity,
    ]);
    await call("agent", { command: "cancel", id: started.id });
    await call("agent", { command: "reconcile" });
    const awaited = z.object({ reason: z.literal("satisfied") }).parse(
      await call("await", {
        query: "agent-run-settled",
        params: { runId: started.id },
        minCount: 1,
        timeoutSecs: 0,
      }),
    );
    assert.equal(awaited.reason, "satisfied");

    const released = taskDetail.parse(
      await call("work", { command: "show", id: target, history: true }),
    );
    assert.equal(released.item.assignment, null);
    assert.equal(released.item.acceptanceCriteria[0]?.condition, "Preserve criterion");
    assert.deepEqual(
      released.prerequisites.map(({ id }) => id),
      [prerequisite],
    );
    assert.equal(
      released.history?.assignments.some(
        (entry) => entry.id === assigned.id && entry.release !== null,
      ),
      true,
    );
    assert.equal(
      taskDetail.parse(await call("work", { command: "show", id: human })).item.assignment
        ?.assignee,
      "human",
    );
    return ["packaged CLI managed cancellation", "settled await", "matching release only"];
  } finally {
    await host.close();
  }
}

const managed = await managedPhase();
const direct = await directPhase();
const missedSettlement = await missedSettlementPhase();
const packaged = await packagedPhase();
process.stdout.write(
  `work-agent smoke verified: ${[...managed, ...direct, ...missedSettlement, ...packaged].join("; ")}\n`,
);
