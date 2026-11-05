// Black-box verification for live native XState promise invocations.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { system } from "../tests/blackbox/fixtures/system.ts";

const runView = z.object({
  run: z.object({
    id: z.string(),
    context: z.string(),
    title: z.string(),
    status: z.enum(["active", "waiting", "blocked", "complete", "failed"]),
  }),
  invocations: z.array(
    z.object({ id: z.string(), path: z.array(z.string()), status: z.string().min(1) }),
  ),
  tasks: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      status: z.enum(["ready", "blocked", "done"]),
      actionPending: z.boolean(),
    }),
  ),
  history: z.array(z.object({ id: z.string(), title: z.string(), choice: z.string() })),
  taskPage: z.object({ total: z.number(), nextOffset: z.number().nullable() }),
  historyPage: z.object({ total: z.number(), nextOffset: z.number().nullable() }),
});
const waitResult = z.object({ reason: z.enum(["satisfied", "timeout"]) });

type GateResponse = { status: number };
type Endpoint = "ci" | "child";

function makeControl() {
  return { started: Promise.withResolvers<void>(), release: Promise.withResolvers<GateResponse>() };
}

function controlAt(endpoint: Endpoint, index: number) {
  const control = controls[endpoint][index];
  if (control === undefined) throw new Error(`Missing ${endpoint} control ${index + 1}`);
  return control;
}

const controls = {
  ci: [makeControl(), makeControl()],
  child: [makeControl(), makeControl()],
};
const counts = { checks: 0, ci: 0, child: 0 };

const host = await system();
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/checks") {
      counts.checks += 1;
      return Response.json({ checks: "passed" });
    }
    if (path === "/ci" || path === "/child") {
      const endpoint: Endpoint = path === "/ci" ? "ci" : "child";
      const index = counts[endpoint]++;
      const control = controlAt(endpoint, index);
      control.started.resolve();
      const result = await control.release.promise;
      return Response.json({ status: result.status }, { status: result.status });
    }
    return new Response(`Unknown endpoint: ${path}`, { status: 404 });
  },
});

const releaseAll = () => {
  for (const endpoint of Object.values(controls))
    for (const control of endpoint) control.release.resolve({ status: 200 });
};

try {
  const workspace = await host.workspace("workflow-invokes-smoke", [
    "@botlake/extension-batteries",
    "@botlake/extension-identity",
    "@botlake/extension-work",
    "@botlake/extension-workflow",
  ]);
  const example = await Bun.file(
    new URL(import.meta.resolve("@botlake/extension-workflow/examples/native-invokes")),
  ).text();
  const controlUrl = server.url.toString().replace(/\/$/u, "");
  const workflowInput = {
    controlUrl,
    workspace,
    checksFile: join(workspace, ".workflows/invokes/checks.test.ts"),
  };

  for (const [name, machine] of [
    ["invokes", "machine"],
    ["native-child", "nativeChildMachine"],
  ] as const) {
    const directory = join(workspace, ".workflows", name);
    await mkdir(directory, { recursive: true });
    await Bun.write(join(directory, "native-invokes.ts"), example);
    await Bun.write(
      join(directory, "workflow.ts"),
      `import { ${machine} as machine } from "./native-invokes.ts";\nexport { inputSchema, commandSchemas, runBrief } from "./native-invokes.ts";\nexport { machine };\n`,
    );
    await Bun.write(
      join(directory, "workflow.toml"),
      `version = "1.0.0"\ndescription = "Native promise invocation smoke"\nrun = "workflow.ts"\n`,
    );
  }

  await Bun.write(
    workflowInput.checksFile,
    `import { expect, test } from "bun:test";\n\ntest("Bun check reports its result to the controlled endpoint", async () => {\n  const controlUrl = process.env["BOTLAKE_CONTROL_URL"];\n  if (controlUrl === undefined) throw new Error("Missing BOTLAKE_CONTROL_URL");\n  const response = await fetch(new URL("/checks", controlUrl));\n  expect(response.status).toBe(200);\n  expect(await response.json()).toEqual({ checks: "passed" });\n});\n`,
  );

  await host.botlake(["lake", "start", "--workspace", workspace]);
  const cli = (args: string[], ok = true) => host.cli(["--workspace", workspace, ...args], ok);
  const showRun = async (id: string) => runView.parse(await cli(["workflow", "show", id]));
  const task = (view: z.infer<typeof runView>, title: string) =>
    z.string().parse(view.tasks.find((candidate) => candidate.title === title)?.id);
  const complete = async (taskId: string, choice: string) =>
    runView.parse(await cli(["workflow", "complete", taskId, choice]));
  const waitForTaskCount = async (count: number) => {
    const result = waitResult.parse(
      await cli([
        "await",
        "--query",
        "workflow-tasks",
        "--min-count",
        String(count),
        "--timeout-secs",
        "60",
      ]),
    );
    assert.equal(result.reason, "satisfied", `workflow-tasks did not reach ${count}`);
  };

  // The first promise runs an actual Bun test suite, then advances without another CLI action.
  const started = runView.parse(
    await cli(["workflow", "start", "invokes", "--input", JSON.stringify(workflowInput)]),
  );
  await waitForTaskCount(1);
  const implement = task(started, "Implement change");
  const checking = await complete(implement, "done");
  assert.equal(checking.run.status, "waiting");
  assert.equal(checking.tasks.length, 0);
  assert.ok(checking.invocations.some(({ id }) => id === "bun-checks"));
  await waitForTaskCount(2);
  const afterChecks = await showRun(started.run.id);
  assert.equal(counts.checks, 1, "Bun checks should execute once in this activation");
  assert.equal(afterChecks.run.status, "active");
  assert.deepEqual(
    afterChecks.tasks.map(({ title }) => title),
    ["Raise PR"],
  );
  assert.deepEqual(
    afterChecks.history.map(({ id }) => id),
    [implement],
  );

  // CI is held by the local endpoint to inspect the persisted invocation after CLI return.
  const raisePr = task(afterChecks, "Raise PR");
  const waitingCi = await complete(raisePr, "done");
  await controlAt("ci", 0).started.promise;
  assert.equal(waitingCi.run.status, "waiting");
  assert.equal(waitingCi.tasks.length, 0);
  assert.deepEqual(
    waitingCi.history.map(({ id }) => id),
    [implement, raisePr],
  );
  assert.ok(waitingCi.invocations.some(({ id }) => id === "controlled-ci"));
  const noExtraTask = waitResult.parse(
    await cli(["await", "--query", "workflow-tasks", "--max-count", "2", "--timeout-secs", "0"]),
  );
  assert.equal(noExtraTask.reason, "satisfied");
  assert.equal(counts.ci, 1, "CI should start once before restart");

  // A restart restores the same visit IDs and re-executes the still-pending promise once.
  await host.botlake(["lake", "restart", "--workspace", workspace]);
  await controlAt("ci", 1).started.promise;
  const restarted = await showRun(started.run.id);
  assert.equal(restarted.run.status, "waiting");
  assert.equal(restarted.tasks.length, 0);
  assert.deepEqual(restarted.history, waitingCi.history);
  assert.deepEqual(
    restarted.history.map(({ id }) => id),
    [implement, raisePr],
  );
  assert.ok(restarted.invocations.some(({ id }) => id === "controlled-ci"));
  assert.equal(counts.ci, 2, "restart should re-execute the pending CI promise exactly once");

  controlAt("ci", 1).release.resolve({ status: 200 });
  await waitForTaskCount(3);
  const merge = await showRun(started.run.id);
  assert.equal(merge.run.status, "active");
  assert.deepEqual(
    merge.tasks.map(({ title }) => title),
    ["Merge PR"],
  );
  assert.deepEqual(
    merge.history.map(({ id }) => id),
    [implement, raisePr],
  );
  assert.equal(counts.ci, 2);
  const merged = await complete(task(merge, "Merge PR"), "merge");
  assert.equal(merged.run.status, "complete");
  assert.equal(merged.tasks.length, 0);

  // Native child-machine promise completion and onError each publish their authored child visit.
  const childRun = runView.parse(
    await cli(["workflow", "start", "native-child", "--input", JSON.stringify(workflowInput)]),
  );
  await waitForTaskCount(4);
  const childSetup = task(childRun, "Prepare child action");
  const childWaiting = await complete(childSetup, "continue");
  await controlAt("child", 0).started.promise;
  assert.equal(childWaiting.run.status, "waiting");
  assert.equal(childWaiting.tasks.length, 0);
  assert.ok(
    childWaiting.invocations.some(({ id, path }) => id === "child-async-action" && path.length > 0),
  );
  assert.equal(counts.child, 1, "native child promise should start once");
  controlAt("child", 0).release.resolve({ status: 200 });
  await waitForTaskCount(5);
  const childPublished = await showRun(childRun.run.id);
  assert.equal(childPublished.run.status, "active");
  assert.deepEqual(
    childPublished.tasks.map(({ title }) => title),
    ["Child async result"],
  );
  assert.deepEqual(
    childPublished.history.map(({ id }) => id),
    [childSetup],
  );
  await complete(task(childPublished, "Child async result"), "done");
  assert.equal((await showRun(childRun.run.id)).run.status, "complete");

  const errorRun = runView.parse(
    await cli(["workflow", "start", "native-child", "--input", JSON.stringify(workflowInput)]),
  );
  await waitForTaskCount(6);
  const errorSetup = task(errorRun, "Prepare child action");
  const errorWaiting = await complete(errorSetup, "continue");
  await controlAt("child", 1).started.promise;
  assert.equal(errorWaiting.run.status, "waiting");
  assert.equal(counts.child, 2, "second native child activation should start once");
  controlAt("child", 1).release.resolve({ status: 503 });
  await waitForTaskCount(7);
  const routedError = await showRun(errorRun.run.id);
  assert.equal(routedError.run.status, "active");
  assert.deepEqual(
    routedError.tasks.map(({ title }) => title),
    ["Child onError route"],
  );
  assert.deepEqual(
    routedError.history.map(({ id }) => id),
    [errorSetup],
  );
  await complete(task(routedError, "Child onError route"), "done");
  assert.equal((await showRun(errorRun.run.id)).run.status, "complete");

  console.log(
    JSON.stringify(
      {
        ok: true,
        verified: [
          "packaged CLI runs real Bun checks from a native fromPromise invocation exactly once",
          "unresolved CI remains waiting with no active Work tasks after the command returns",
          "restart re-executes a pending promise once while retaining run, task and history IDs",
          "resolving controlled CI automatically publishes the merge task",
          "native child-machine promise completion publishes its next task",
          "native child-machine onError routes publish the authored recovery task",
        ],
      },
      null,
      2,
    ),
  );
} finally {
  releaseAll();
  await server.stop(true);
  await host.close();
}
