import { expect, test } from "bun:test";
import { join } from "node:path";

import { z } from "zod";

import { system } from "./fixtures/system.ts";
import { writeWorkflowExtension } from "./fixtures/workflows.ts";

const idResult = z.object({ id: z.string() });
const startedResult = z.object({
  run: z.object({ id: z.string(), context: z.string() }),
  tasks: z.array(z.object({ id: z.string() })),
});
const abandonedResult = z.object({
  id: z.string(),
  workId: z.string(),
  state: z.string(),
  reason: z.string(),
  by: z.string(),
  cooperation: z.object({ workflows: z.array(z.string()) }).nullable(),
  closed: z.object({
    tasks: z.array(z.string()),
    gates: z.array(z.string()),
    groups: z.array(z.string()),
  }),
});
const shownRun = z.object({
  run: z.object({
    id: z.string(),
    context: z.string(),
    status: z.string(),
    abandonment: z.unknown().nullable(),
  }),
  tasks: z.array(z.object({ id: z.string(), actionPending: z.boolean() })),
  history: z.array(z.object({ id: z.string(), title: z.string(), choice: z.string() })),
});
const shownTask = z.object({
  run: z.object({ id: z.string(), status: z.string() }),
  tasks: z.array(
    z.object({
      id: z.string(),
      actionPending: z.boolean(),
      status: z.string(),
      result: z.unknown().nullable(),
      work: z.object({ item: z.object({ state: z.string(), revision: z.number() }) }),
    }),
  ),
});
const workItem = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  kind: z.string(),
  state: z.string(),
  revision: z.number(),
  notes: z.string().nullable().optional(),
  assignment: z.unknown().nullable().optional(),
  acceptanceCriteria: z
    .array(
      z.object({
        id: z.string(),
        condition: z.string(),
        state: z.string(),
        resolution: z.unknown(),
      }),
    )
    .optional(),
  status: z.object({ status: z.string() }).optional(),
});
const workHistory = z.object({
  item: workItem,
  prerequisites: z.array(z.object({ id: z.string(), state: z.string() })).optional(),
  history: z.object({
    assignments: z.array(z.object({ id: z.string(), release: z.unknown().nullable() })),
    criteria: z.array(z.unknown()),
    closures: z.array(z.unknown()),
    abandonments: z.array(z.object({ by: z.string(), at: z.string(), reason: z.string() })),
  }),
});
const nodeAttributes = z.object({ attributes: z.record(z.string(), z.unknown()) });

test("packed CLI abandonment is scoped, terminal, atomic and does not reactivate authored runs", async () => {
  const fixture = await system();
  try {
    const workspace = await fixture.workspace("abandonment", [
      "@botlake/extension-batteries",
      "@botlake/extension-identity",
      "./work.ts",
      "./workflow-extension.ts",
    ]);
    await Bun.write(
      join(workspace, "work.ts"),
      `import { defineProbe, work } from "@botlake/extension-work";
import { z } from "zod";
export default work({ probes: [defineProbe({
  name: "quiet", description: "A cancellable test gate", params: z.object({}),
  policy: { everyMs: 3600000, maxAttempts: 2, timeoutMs: 1000 },
  async run(_params, { signal }) {
    await new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
    return { outcome: "failed", message: "withdrawn" };
  },
})] });
`,
    );
    const abandonmentDefinition = join(workspace, "abandonment-workflow.ts");
    await Bun.write(
      abandonmentDefinition,
      `import { setup } from "xstate";
import { z } from "zod";
import { defineWorkflow } from "@botlake/extension-workflow";
const machine = setup({}).createMachine({
  initial: "waiting",
  states: {
    waiting: {
      meta: { title: "Pending release", commands: { finish: "FINISH" }, task: () => ({ instructions: "Publish only after release" }) },
      on: { FINISH: "done" },
    },
    done: { type: "final" },
  },
});
export const workflow = defineWorkflow({
  name: "abandonment", version: "1.0.0", description: "Abandonment fixture",
  inputSchema: z.object({}), commandSchemas: { finish: z.object({}) },
  runBrief: () => ({ title: "Release run", description: "Fixture" }), machine,
});
`,
    );
    const parallelDefinition = join(workspace, "parallel-abandonment.ts");
    await Bun.write(
      parallelDefinition,
      `import { setup } from "xstate";
import { z } from "zod";
import { defineWorkflow } from "@botlake/extension-workflow";
const machine = setup({}).createMachine({
  type: "parallel",
  states: {
    alpha: { initial: "working", states: {
      working: { meta: { title: "Alpha sibling", commands: { finish: "ALPHA_FINISH" }, task: () => ({ instructions: "Complete alpha" }) }, on: { ALPHA_FINISH: "done" } },
      done: { type: "final" },
    } },
    beta: { initial: "working", states: {
      working: { meta: { title: "Beta sibling", commands: { finish: "BETA_FINISH" }, task: () => ({ instructions: "Complete beta" }) }, on: { BETA_FINISH: "done" } },
      done: { type: "final" },
    } },
  },
});
export const workflow = defineWorkflow({
  name: "parallel-abandonment", version: "1.0.0", description: "Parallel siblings",
  inputSchema: z.object({}), commandSchemas: { finish: z.object({}) },
  runBrief: () => ({ title: "Parallel run", description: "Fixture" }), machine,
});
`,
    );
    const frozenDefinition = join(workspace, "frozen-publication.ts");
    await Bun.write(
      frozenDefinition,
      `import { setup } from "xstate";
import { z } from "zod";
import { defineWorkflow } from "@botlake/extension-workflow";
const machine = setup({}).createMachine({
  initial: "first",
  states: {
    first: { meta: { title: "Checkpoint before publication", commands: { continue: "CONTINUE" }, task: () => ({ instructions: "Advance to the unavailable probe" }) }, on: { CONTINUE: "second" } },
    second: { meta: { title: "Frozen unpublished task", commands: { finish: "FINISH" }, task: () => ({ instructions: "This task must never publish" }), gates: () => [{ title: "Unavailable probe gate", probe: "missing-probe", params: {} }] }, on: { FINISH: "done" } },
    done: { type: "final" },
  },
});
export const workflow = defineWorkflow({
  name: "frozen-publication", version: "1.0.0", description: "Abandoned pending publication",
  inputSchema: z.object({}), commandSchemas: { continue: z.object({}), finish: z.object({}) },
  runBrief: () => ({ title: "Frozen publication run", description: "Fixture" }), machine,
});
`,
    );
    await writeWorkflowExtension(workspace, [
      abandonmentDefinition,
      parallelDefinition,
      frozenDefinition,
    ]);
    await fixture.botlake(["lake", "start", "--workspace", "abandonment"]);
    const bl = (operation: string, input: unknown, ok?: boolean) =>
      fixture.bl("abandonment", operation, input, ok);
    const showWork = (id: string) => bl("work", { command: "show", id, history: true });
    const showRun = (id: string) => bl("workflow", { command: "show", id });
    const create = (input: Record<string, unknown>) => bl("work", { command: "create", ...input });
    const start = (name: string, input: Record<string, unknown> = {}, parent?: string) =>
      bl("workflow", {
        command: "start",
        name,
        input,
        ...(parent === undefined ? {} : { parent }),
      });

    // The packed help and JSON schema declare a required, nonblank reason.
    const help = z
      .array(z.object({ cli: z.object({ flags: z.record(z.string(), z.unknown()) }) }))
      .parse(await fixture.cli(["--workspace", "abandonment", "help", "work", "abandon"]));
    expect(help[0]?.cli.flags["reason"]).toMatchObject({ required: true, type: "string" });
    const rawSchema = z
      .array(z.unknown())
      .parse(await fixture.cli(["--workspace", "abandonment", "schema", "work"]))[0];
    const inputSchema = z
      .object({
        jsonSchema: z.object({ input: z.object({ oneOf: z.array(z.unknown()) }) }),
      })
      .parse(rawSchema).jsonSchema.input.oneOf;
    const abandonSchema = inputSchema
      .map((variant) =>
        z
          .object({
            properties: z.object({
              command: z.object({ const: z.string() }),
              reason: z.object({ type: z.string(), minLength: z.number() }).optional(),
            }),
            required: z.array(z.string()),
          })
          .safeParse(variant),
      )
      .find(
        (variant) => variant.success && variant.data.properties.command.const === "abandon",
      )?.data;
    expect(abandonSchema?.required).toContain("reason");
    expect(abandonSchema?.properties.reason).toMatchObject({ type: "string", minLength: 1 });
    const reasonTarget = idResult.parse(
      await create({ kind: "group", title: "Reason validation target" }),
    );
    expect(
      String(
        await fixture.cli(
          ["--workspace", "abandonment", "work", "abandon", reasonTarget.id],
          false,
        ),
      ),
    ).toContain("reason");
    expect(
      String(
        await fixture.cli(
          ["--workspace", "abandonment", "work", "abandon", reasonTarget.id, "--reason", "  "],
          false,
        ),
      ),
    ).toContain("reason");
    expect(workHistory.parse(await showWork(reasonTarget.id)).item.state).toBe("open");
    const directTask = idResult.parse(
      await create({
        kind: "task",
        title: "Direct unfinished task",
        acceptanceCriteria: ["Still open"],
      }),
    );
    const directAssignment = z
      .object({ assignment: z.object({ id: z.string() }) })
      .parse(
        await bl("work", { command: "claim", id: directTask.id, assignee: "direct-worker" }),
      ).assignment;
    const directTaskAbandonment = abandonedResult.parse(
      await bl("work", { command: "abandon", id: directTask.id, reason: "Stop this task" }),
    );
    expect(directTaskAbandonment.closed.tasks).toEqual([directTask.id]);
    const directTaskAfter = workHistory.parse(await showWork(directTask.id));
    expect(directTaskAfter.item).toMatchObject({
      state: "closed",
      assignment: null,
      acceptanceCriteria: [{ state: "open" }],
    });
    expect(directTaskAfter.history.assignments[0]).toMatchObject({
      id: directAssignment.id,
      release: { reason: "Stop this task" },
    });

    // Standalone abandonment bypasses unresolved criteria and never follows prerequisites.
    const outerGroup = idResult.parse(await create({ kind: "group", title: "Withdrawn scope" }));
    const innerGroup = idResult.parse(
      await create({ kind: "group", title: "Nested scope", parent: outerGroup.id }),
    );
    const externalDependency = idResult.parse(
      await create({ kind: "task", title: "Unrelated prerequisite" }),
    );
    const unfinished = idResult.parse(
      await create({
        kind: "task",
        title: "Blocked task with unresolved criterion",
        parent: innerGroup.id,
        prerequisites: [externalDependency.id],
        acceptanceCriteria: ["Evidence is still missing"],
      }),
    );
    const unresolved = workHistory.parse(await showWork(unfinished.id));
    const criterionId = unresolved.item.acceptanceCriteria?.[0]?.id;
    expect(criterionId).toBeString();
    expect(unresolved.item.acceptanceCriteria?.[0]?.state).toBe("open");
    const assigned = idResult.parse(
      await create({ kind: "task", title: "Assigned task", parent: innerGroup.id }),
    );
    const assignment = z
      .object({ assignment: z.object({ id: z.string(), assignee: z.string() }) })
      .parse(
        await bl("work", { command: "claim", id: assigned.id, assignee: "worker" }),
      ).assignment;
    const completed = idResult.parse(
      await create({
        kind: "task",
        title: "Completed descendant",
        parent: innerGroup.id,
      }),
    );
    const completedCriterion = idResult.parse(
      await bl("work", {
        command: "criterion",
        operation: "add",
        id: completed.id,
        condition: "Historical evidence",
      }),
    );
    await bl("work", {
      command: "criterion",
      operation: "resolve",
      id: completed.id,
      criterion: completedCriterion.id,
      text: "Recorded before withdrawal",
    });
    const completedAssignment = z
      .object({ assignment: z.object({ id: z.string() }) })
      .parse(
        await bl("work", { command: "claim", id: completed.id, assignee: "closer" }),
      ).assignment;
    await bl("work", { command: "update", id: completed.id, notes: "Historical note" });
    await bl("work", { command: "close", id: completed.id });
    const completedBefore = await showWork(completed.id);
    const gate = idResult.parse(
      await bl("gate", {
        command: "create",
        title: "Open contained gate",
        probe: "quiet",
        parent: innerGroup.id,
      }),
    );
    const standalone = abandonedResult.parse(
      await bl("work", {
        command: "abandon",
        id: outerGroup.id,
        reason: "Scope withdrawn",
      }),
    );
    expect(standalone).toMatchObject({
      state: "abandoned",
      workId: outerGroup.id,
      reason: "Scope withdrawn",
      by: "fixture",
    });
    expect(standalone.closed.tasks.toSorted()).toEqual([unfinished.id, assigned.id].toSorted());
    expect(standalone.closed.tasks).not.toContain(completed.id);
    expect(standalone.closed.gates).toContain(gate.id);
    expect(standalone.closed.groups.toSorted()).toEqual([innerGroup.id, outerGroup.id].toSorted());
    const abandonedTask = workHistory.parse(await showWork(unfinished.id));
    expect(abandonedTask.item).toMatchObject({
      state: "closed",
      acceptanceCriteria: [{ state: "open" }],
    });
    expect(abandonedTask.prerequisites?.map(({ id }) => id)).toContain(externalDependency.id);
    const released = workHistory.parse(await showWork(assigned.id));
    expect(released.item).toMatchObject({ state: "closed", assignment: null });
    expect(released.history.assignments[0]?.release).toMatchObject({
      reason: "Scope withdrawn",
      by: "fixture",
    });
    expect(released.history.assignments[0]?.release).not.toBeNull();
    expect(released.history.assignments[0]).toMatchObject({ id: assignment.id });
    expect(workHistory.parse(await showWork(gate.id)).item).toMatchObject({
      state: "closed",
      status: { status: "dismissed" },
    });
    expect(workHistory.parse(await showWork(outerGroup.id)).item.state).toBe("closed");
    expect(workHistory.parse(await showWork(innerGroup.id)).item.state).toBe("closed");
    expect(workHistory.parse(await showWork(externalDependency.id)).item.state).toBe("open");
    const directGate = idResult.parse(
      await bl("gate", { command: "create", title: "Direct open gate", probe: "quiet" }),
    );
    const directGateAbandonment = abandonedResult.parse(
      await bl("work", { command: "abandon", id: directGate.id, reason: "Condition withdrawn" }),
    );
    expect(directGateAbandonment.closed.gates).toEqual([directGate.id]);
    expect(workHistory.parse(await showWork(directGate.id)).item).toMatchObject({
      state: "closed",
      status: { status: "dismissed" },
    });
    expect(workHistory.parse(await showWork(completed.id)).item).toEqual(
      workHistory.parse(completedBefore).item,
    );
    expect(workHistory.parse(await showWork(completed.id)).history).toEqual(
      workHistory.parse(completedBefore).history,
    );
    expect(workHistory.parse(completedBefore).history.assignments[0]?.release).toMatchObject({
      reason: "closed",
    });
    expect(workHistory.parse(completedBefore).history.assignments[0]).toMatchObject({
      id: completedAssignment.id,
    });
    const rootAfter = await showWork(outerGroup.id);
    const retry = abandonedResult.parse(
      await bl("work", {
        command: "abandon",
        id: outerGroup.id,
        reason: "Scope withdrawn",
      }),
    );
    expect(retry.closed).toEqual({ tasks: [], gates: [], groups: [] });
    expect(await showWork(outerGroup.id)).toEqual(rootAfter);
    expect(
      String(
        await bl(
          "work",
          { command: "abandon", id: outerGroup.id, reason: "Different reason" },
          false,
        ),
      ),
    ).toContain("original reason");
    expect(await showWork(outerGroup.id)).toEqual(rootAfter);
    expect(
      String(await bl("work", { command: "reopen", id: outerGroup.id, reason: "Undo" }, false)),
    ).toContain("terminal");
    expect(await showWork(outerGroup.id)).toEqual(rootAfter);

    // Generic close can leave an authored action pending; abandoning the closed context recovers it.
    const recovery = startedResult.parse(await start("abandonment"));
    const recoveryTask = recovery.tasks[0];
    if (recoveryTask === undefined) throw new Error("Expected authored recovery task");
    await bl("work", { command: "close", id: recoveryTask.id });
    await bl("work", { command: "close", id: recovery.run.context });
    expect(shownRun.parse(await showRun(recovery.run.id)).tasks).toMatchObject([
      { id: recoveryTask.id, actionPending: true },
    ]);
    const pendingRecovery = shownTask.parse(
      await bl("workflow", { command: "show", id: recoveryTask.id }),
    );
    expect(pendingRecovery.tasks[0]?.actionPending).toBe(true);
    const recovered = abandonedResult.parse(
      await bl("work", {
        command: "abandon",
        id: recovery.run.id,
        reason: "No release is needed",
      }),
    );
    expect(recovered.closed).toEqual({ tasks: [], gates: [], groups: [] });
    expect(shownRun.parse(await showRun(recovery.run.id))).toMatchObject({
      run: { status: "abandoned" },
      tasks: [],
      history: [],
    });
    expect(
      shownTask.parse(await bl("workflow", { command: "show", id: recoveryTask.id })).tasks[0],
    ).toMatchObject({ id: recoveryTask.id, actionPending: false, status: "done" });

    // A task target from a parallel run expands to its run context, not the outer group.
    const enclosing = idResult.parse(await create({ kind: "group", title: "Business context" }));
    const unrelatedSibling = idResult.parse(
      await create({ kind: "task", title: "Unrelated business task", parent: enclosing.id }),
    );
    const parallel = startedResult.parse(await start("parallel-abandonment", {}, enclosing.id));
    expect(parallel.tasks).toHaveLength(2);
    const [first, second] = parallel.tasks;
    if (first === undefined || second === undefined) throw new Error("Expected parallel siblings");
    await bl("work", { command: "claim", id: first.id, assignee: "reviewer" });
    await bl("workflow", { command: "complete", id: first.id, choice: "finish" });
    const afterCompletion = shownRun.parse(await showRun(parallel.run.id));
    expect(afterCompletion.history).toHaveLength(1);
    expect(afterCompletion.history[0]).toMatchObject({ id: first.id, choice: "finish" });
    expect(afterCompletion.tasks).toMatchObject([{ id: second.id, actionPending: true }]);
    const completedTaskBeforeAbandon = shownTask.parse(
      await bl("workflow", { command: "show", id: first.id }),
    );
    expect(completedTaskBeforeAbandon.tasks[0]?.result).toMatchObject({ choice: "finish" });
    const parallelAbandonment = abandonedResult.parse(
      await bl("work", {
        command: "abandon",
        id: second.id,
        reason: "Parallel work withdrawn",
      }),
    );
    expect(parallelAbandonment).toMatchObject({
      id: second.id,
      workId: parallel.run.context,
      cooperation: { workflows: [parallel.run.id] },
    });
    expect(parallelAbandonment.closed.tasks).toEqual([second.id]);
    expect(parallelAbandonment.closed.groups).toContain(parallel.run.context);
    const abandonedParallel = shownRun.parse(await showRun(parallel.run.id));
    expect(abandonedParallel).toMatchObject({
      run: { status: "abandoned" },
      tasks: [],
      history: [{ id: first.id, choice: "finish" }],
    });
    const pendingSibling = shownTask.parse(
      await bl("workflow", { command: "show", id: second.id }),
    );
    expect(pendingSibling.tasks[0]).toMatchObject({
      id: second.id,
      actionPending: false,
      status: "done",
    });
    expect(pendingSibling.run.status).toBe("abandoned");
    expect(
      shownTask.parse(await bl("workflow", { command: "show", id: first.id })).tasks[0],
    ).toMatchObject({
      id: first.id,
      actionPending: false,
      result: { choice: "finish" },
    });
    expect(
      shownTask.parse(await bl("workflow", { command: "show", id: first.id })).tasks[0]?.work,
    ).toEqual(completedTaskBeforeAbandon.tasks[0]?.work);
    expect(await showWork(enclosing.id)).toMatchObject({ item: { state: "open" } });
    expect(await showWork(unrelatedSibling.id)).toMatchObject({ item: { state: "open" } });
    expect(
      shownRun.parse(await bl("workflow", { command: "complete", id: first.id, choice: "finish" })),
    ).toEqual(abandonedParallel);
    const beforeRefusedCompletion = await showRun(parallel.run.id);
    expect(
      String(await bl("workflow", { command: "complete", id: second.id, choice: "finish" }, false)),
    ).toContain("complete");
    expect(await showRun(parallel.run.id)).toEqual(beforeRefusedCompletion);

    // A nested prior abandonment with a conflicting reason aborts the outer tree atomically.
    const nestedRoot = idResult.parse(await create({ kind: "group", title: "Nested runs" }));
    const outerTask = idResult.parse(
      await create({ kind: "task", title: "Outer unfinished work", parent: nestedRoot.id }),
    );
    const nested = startedResult.parse(await start("abandonment", {}, nestedRoot.id));
    await bl("workflow", {
      command: "abandon",
      id: nested.run.id,
      reason: "Inner agreed reason",
    });
    const nestedTask = nested.tasks[0];
    if (nestedTask === undefined) throw new Error("Expected nested authored task");
    const beforeConflict = {
      root: await showWork(nestedRoot.id),
      outerTask: await showWork(outerTask.id),
      context: await showWork(nested.run.context),
      run: await showRun(nested.run.id),
      task: await bl("workflow", { command: "show", id: nestedTask.id }),
    };
    expect(
      String(
        await bl(
          "work",
          { command: "abandon", id: nestedRoot.id, reason: "Conflicting outer reason" },
          false,
        ),
      ),
    ).toContain("original reason");
    expect({
      root: await showWork(nestedRoot.id),
      outerTask: await showWork(outerTask.id),
      context: await showWork(nested.run.context),
      run: await showRun(nested.run.id),
      task: await bl("workflow", { command: "show", id: nestedTask.id }),
    }).toEqual(beforeConflict);
    const outerAbandonment = abandonedResult.parse(
      await bl("work", {
        command: "abandon",
        id: nestedRoot.id,
        reason: "Inner agreed reason",
      }),
    );
    expect(outerAbandonment.closed.tasks).toContain(outerTask.id);
    expect(outerAbandonment.closed.groups).toContain(nestedRoot.id);
    expect(await showWork(outerTask.id)).toMatchObject({ item: { state: "closed" } });
    expect(shownRun.parse(await showRun(nested.run.id)).run.status).toBe("abandoned");

    // Failed frozen publication is cancelled by abandonment, including across restart.
    const frozen = startedResult.parse(await start("frozen-publication"));
    const frozenTask = frozen.tasks[0];
    if (frozenTask === undefined) throw new Error("Expected initial frozen-publication task");
    expect(
      String(
        await bl("workflow", { command: "complete", id: frozenTask.id, choice: "continue" }, false),
      ),
    ).toContain("publication pending");
    const pendingAttributes = nodeAttributes.parse(
      await bl("node", { command: "show", id: frozen.run.id }),
    ).attributes;
    expect(pendingAttributes["workflow/publication"]).not.toBeNull();
    const frozenAbandonment = abandonedResult.parse(
      await bl("workflow", {
        command: "abandon",
        id: frozen.run.id,
        reason: "Do not publish frozen work",
      }),
    );
    expect(frozenAbandonment).toMatchObject({ state: "abandoned", workId: frozen.run.context });
    expect(
      nodeAttributes.parse(await bl("node", { command: "show", id: frozen.run.id })).attributes[
        "workflow/publication"
      ],
    ).toBeUndefined();
    expect(shownRun.parse(await showRun(frozen.run.id))).toMatchObject({
      run: { status: "abandoned" },
      tasks: [],
      history: [{ id: frozenTask.id, title: "Checkpoint before publication", choice: "continue" }],
    });

    // An identical retry preserves original attribution; restart never republishes abandoned work.
    const recoveryHistory = workHistory.parse(await showWork(recovery.run.context));
    expect(recoveryHistory.history.abandonments).toHaveLength(1);
    expect(recoveryHistory.history.abandonments[0]).toMatchObject({
      by: "fixture",
      reason: "No release is needed",
    });
    const recoveryAt = recoveryHistory.history.abandonments[0]?.at;
    const sameReasonRetry = abandonedResult.parse(
      await bl("workflow", {
        command: "abandon",
        id: recovery.run.id,
        reason: "No release is needed",
      }),
    );
    expect(sameReasonRetry.reason).toBe("No release is needed");
    expect(workHistory.parse(await showWork(recovery.run.context)).history.abandonments).toEqual(
      recoveryHistory.history.abandonments,
    );
    await fixture.botlake(["lake", "restart", "--workspace", "abandonment"]);
    for (const runId of [recovery.run.id, parallel.run.id, nested.run.id, frozen.run.id])
      expect(shownRun.parse(await showRun(runId)).run.status).toBe("abandoned");
    expect(
      shownTask.parse(await bl("workflow", { command: "show", id: frozenTask.id })).tasks[0],
    ).toMatchObject({ actionPending: false, status: "done" });
    expect(
      workHistory.parse(await showWork(recovery.run.context)).history.abandonments[0]?.at,
    ).toBe(recoveryAt);
    expect(shownRun.parse(await showRun(frozen.run.id))).toMatchObject({
      tasks: [],
      history: [{ id: frozenTask.id, choice: "continue" }],
    });
  } finally {
    await fixture.close();
  }
}, 60000);
