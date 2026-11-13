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
  state: z.string(),
  reason: z.string(),
  cooperation: z.object({ workflows: z.array(z.string()) }),
  closed: z.object({
    tasks: z.array(z.string()),
    gates: z.array(z.string()),
    groups: z.array(z.string()),
  }),
});
const shownRun = z.object({
  run: z.object({ status: z.string() }),
  tasks: z.array(z.unknown()),
  history: z.array(z.unknown()),
});
const abandonmentHistory = z.object({
  history: z.object({
    abandonments: z.array(z.object({ by: z.string(), at: z.string(), reason: z.string() })),
  }),
});
const workHistory = z.object({
  item: z.object({
    state: z.string(),
    acceptanceCriteria: z.array(z.object({ state: z.string() })),
    assignment: z.unknown().nullable(),
  }),
  history: z.object({
    assignments: z.array(z.object({ release: z.object({ reason: z.string() }).nullable() })),
  }),
});
const shownWork = z.object({ item: z.object({ state: z.string() }) });

test("work abandon terminalizes an authored run whose Work was already closed", async () => {
  const fixture = await system();
  try {
    const workspace = await fixture.workspace("abandonment", [
      "@botlake/extension-identity",
      "@botlake/extension-work",
      "./workflow-extension.ts",
    ]);
    const definition = join(workspace, "abandonment-workflow.ts");
    await Bun.write(
      definition,
      `import { setup } from "xstate";
import { z } from "zod";
import { defineWorkflow } from "@botlake/extension-workflow";
const machine = setup({}).createMachine({
  initial: "waiting",
  states: {
    waiting: {
      meta: {
        title: "Pending release",
        commands: { finish: "FINISH" },
        task: () => ({ instructions: "Publish only after release" }),
      },
      on: { FINISH: "done" },
    },
    done: { type: "final" },
  },
});
export const workflow = defineWorkflow({
  name: "abandonment",
  version: "1.0.0",
  description: "Abandonment fixture",
  inputSchema: z.object({}),
  commandSchemas: { finish: z.object({}) },
  runBrief: () => ({ title: "Release run", description: "Fixture" }),
  machine,
});
`,
    );
    await writeWorkflowExtension(workspace, [definition]);
    await fixture.botlake(["lake", "start", "--workspace", "abandonment"]);

    const started = startedResult.parse(
      await fixture.bl("abandonment", "workflow", {
        command: "start",
        name: "abandonment",
        input: {},
      }),
    );
    const task = started.tasks[0];
    if (task === undefined) throw new Error("Expected authored task");
    await fixture.bl("abandonment", "work", { command: "close", id: task.id });
    await fixture.bl("abandonment", "work", { command: "close", id: started.run.context });

    const abandoned = abandonedResult.parse(
      await fixture.bl("abandonment", "work", {
        command: "abandon",
        id: started.run.id,
        reason: "Consumer maintenance required no release",
      }),
    );
    expect(abandoned).toMatchObject({
      state: "abandoned",
      reason: "Consumer maintenance required no release",
      cooperation: { workflows: [started.run.id] },
      closed: { tasks: [], gates: [], groups: [] },
    });

    const shown = shownRun.parse(
      await fixture.bl("abandonment", "workflow", {
        command: "show",
        id: started.run.id,
      }),
    );
    expect(shown.run.status).toBe("abandoned");
    expect(shown.tasks).toEqual([]);
    expect(shown.history).toEqual([]);

    const detail = abandonmentHistory.parse(
      await fixture.bl("abandonment", "work", {
        command: "show",
        id: started.run.context,
        history: true,
      }),
    );
    expect(detail.history.abandonments).toHaveLength(1);
    expect(detail.history.abandonments[0]).toMatchObject({
      by: "fixture",
      reason: "Consumer maintenance required no release",
    });
    expect(detail.history.abandonments[0]?.at).toBeString();

    const repeated = abandonedResult.parse(
      await fixture.bl("abandonment", "workflow", {
        command: "abandon",
        id: started.run.id,
        reason: "Consumer maintenance required no release",
      }),
    );
    expect(repeated).toMatchObject({
      state: "abandoned",
      cooperation: { workflows: [started.run.id] },
    });

    const missingReason = String(
      await fixture.bl("abandonment", "work", { command: "abandon", id: started.run.id }, false),
    );
    expect(missingReason).toContain("reason");

    const group = idResult.parse(
      await fixture.bl("abandonment", "work", {
        command: "create",
        kind: "group",
        title: "Discarded scope",
      }),
    );
    const unrelated = idResult.parse(
      await fixture.bl("abandonment", "work", {
        command: "create",
        kind: "task",
        title: "External prerequisite",
      }),
    );
    const owned = idResult.parse(
      await fixture.bl("abandonment", "work", {
        command: "create",
        kind: "task",
        title: "Outstanding task",
        parent: group.id,
        acceptanceCriteria: ["Would normally block closure"],
        assignee: "worker",
        prerequisites: [unrelated.id],
      }),
    );
    await fixture.bl("abandonment", "work", {
      command: "abandon",
      id: group.id,
      reason: "Scope withdrawn",
    });
    const ownedAfter = workHistory.parse(
      await fixture.bl("abandonment", "work", {
        command: "show",
        id: owned.id,
        history: true,
      }),
    );
    expect(ownedAfter.item).toMatchObject({
      state: "closed",
      acceptanceCriteria: [{ state: "open" }],
      assignment: null,
    });
    expect(ownedAfter.history.assignments[0]?.release?.reason).toBe("Scope withdrawn");
    expect(
      shownWork.parse(
        await fixture.bl("abandonment", "work", {
          command: "show",
          id: unrelated.id,
        }),
      ),
    ).toMatchObject({ item: { state: "open" } });
  } finally {
    await fixture.close();
  }
});
