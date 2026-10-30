// Opt-in authenticated usability trial. One fresh workspace per agent; no workflow walkthrough.
import assert from "node:assert/strict";
import { copyFile, cp, mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { jsonSchema, q } from "@botlake/core";
import { z } from "zod";

import { system } from "../tests/blackbox/fixtures/system.ts";
import { copyWorkflowExample } from "../tests/blackbox/fixtures/workflows.ts";

const seat = z.enum(["sol", "luna"]).parse(Bun.argv[2]);
const output = resolve(z.string().min(1).parse(Bun.argv[3]));
const model = seat === "sol" ? "openai-codex/gpt-5.6-sol" : "openai-codex/gpt-5.6-luna";
const node = z.object({
  id: z.string(),
  state: z.string(),
  attributes: z.record(z.string(), jsonSchema),
});
const text = z.string();
const host = await system();
let runId: string | undefined;
let workspace: string | undefined;
const brief = `Build a tiny order-total CLI in this workspace.

Input is a JSON array of orders with sku (nonempty string), quantity (nonnegative integer), and unitPriceCents (nonnegative integer). Running bun totals.ts FILE must print exactly one JSON line shaped {"totalCents":NUMBER}. Reject malformed input, missing files, negative/fractional values, or missing fields with a nonzero exit and a useful stderr message; do not print a success result on failure. Empty input totals zero.

Deliver totals.ts, totals.test.ts, and a short README.md. Use the supplied orders.json, add focused tests, and verify the CLI with real commands. Do not change the supplied orders.json or workflow definition files.

Track this work using this workspace's Botlake Kanban and the available authored workflow, with feature progression gated on workflow completion. Leave both workflow and feature completed only after the acceptance criteria are actually verified. Work only in this disposable workspace. Report your verification, the feature/workflow IDs, and any confusing CLI interactions or errors you encountered.`;

await mkdir(output, { recursive: true });
await Bun.write(join(output, "brief.txt"), brief);

try {
  workspace = await host.workspace(`trial-${seat}`, [
    "@botlake/extension-batteries",
    "@botlake/extension-identity",
    "@botlake/extension-kanban",
    "@botlake/extension-workflow",
    "@botlake/extension-workflow-kanban",
    "./flags.ts",
    "./agents.ts",
  ]);
  const definitionFile = await copyWorkflowExample(workspace, "parallel");
  const definitionSource = await Bun.file(definitionFile).text();
  const initialized = await execute(["git", "init", "--quiet"], workspace);
  assert.equal(initialized.code, 0, initialized.stderr);
  const home = join(host.dir, "pi-home");
  await mkdir(home);
  const original = process.env["PI_CODING_AGENT_DIR"] ?? join(homedir(), ".pi/agent");
  await copyFile(join(original, "auth.json"), join(home, "auth.json"));
  if (await Bun.file(join(original, "models.json")).exists())
    await copyFile(join(original, "models.json"), join(home, "models.json"));
  await Bun.write(join(home, "settings.json"), "{}");
  const args = [
    "--no-extensions",
    "--extension",
    join(workspace, "node_modules/@botlake/identity/pi.ts"),
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--no-themes",
    "--offline",
    "--session-dir",
    join(home, "sessions"),
  ];
  await Bun.write(
    join(workspace, "flags.ts"),
    `import {agentFlags} from "@botlake/extension-agents";import {configureFlags} from "@botlake/extension-flags";export default configureFlags([[agentFlags.pi,true]]);`,
  );
  await Bun.write(
    join(workspace, "agents.ts"),
    `import {agents,provider} from "@botlake/extension-agents";
const base=provider("pi");
export default agents({providers:[{...base,prepare(run){const plan=base.prepare(run);return {...plan,env:{...plan.env,PI_CODING_AGENT_DIR:${JSON.stringify(home)}}}}}],aliases:{${seat}:{provider:"pi",model:${JSON.stringify(model)},effort:${JSON.stringify(seat === "sol" ? "low" : "xhigh")},extraArgs:${JSON.stringify(args)}}}});`,
  );
  const sample = [
    { sku: "tea", quantity: 2, unitPriceCents: 325 },
    { sku: "coffee", quantity: 3, unitPriceCents: 900 },
  ];
  await Bun.write(join(workspace, "orders.json"), JSON.stringify(sample));
  await host.botlake(["lake", "start", "--workspace", workspace]);
  const catalog = await host.bl(workspace, "agent", { command: "catalog", name: seat });
  runId = z
    .object({ id: z.string() })
    .parse(
      await host.bl(workspace, "agent", { command: "start", seat, cwd: workspace, prompt: brief }),
    ).id;
  await Bun.write(
    join(output, "running.json"),
    JSON.stringify(
      { seat, model, runId, workspace, home: host.home, bl: host.blBin, botlake: host.botlakeBin },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ seat, model, runId, output, phase: "started" }));
  const waited = z.object({ reason: z.string() }).parse(
    await host.bl(workspace, "await", {
      query: "agent-run-settled",
      params: { runId },
      minCount: 1,
      timeoutSecs: 1200,
    }),
  );
  assert.equal(waited.reason, "satisfied", "Agent trial timed out");
  const run = node.parse(await host.bl(workspace, "agent", { command: "show", id: runId }));
  await Bun.write(join(output, "agent.json"), JSON.stringify({ catalog, run }, null, 2));
  const custody = z
    .object({ output: z.object({ stdout_ref: text, stderr_ref: text }) })
    .parse(run.attributes["agent/custody"]);
  await copyFile(custody.output.stdout_ref, join(output, "agent.stdout.jsonl"));
  await copyFile(custody.output.stderr_ref, join(output, "agent.stderr.txt"));
  await cp(workspace, join(output, "workspace"), {
    recursive: true,
    filter: (path) => !path.split("/").includes("node_modules"),
  });
  await cp(join(home, "sessions"), join(output, "sessions"), { recursive: true });
  const cards = z
    .array(node)
    .parse(
      await host.bl(workspace, "list", { where: q.eq(q.attr("kanban/card"), true), lean: false }),
    );
  const runs = z
    .array(node)
    .parse(
      await host.bl(workspace, "list", { where: q.eq(q.attr("workflow/root"), true), lean: false }),
    );
  const trialWorkspace = workspace;
  const graphs = await Promise.all(
    cards.map((card) => host.bl(trialWorkspace, "subgraph", { id: card.id })),
  );
  const links = z
    .array(z.object({ edges: z.array(z.object({ from_id: text, to_id: text, relation: text })) }))
    .parse(graphs)
    .flatMap((graph) => graph.edges);
  for (const workflow of runs) {
    assert.ok(
      links.some(
        (edge) =>
          edge.relation === "parent-of" &&
          edge.to_id === workflow.id &&
          cards.some((card) => card.id === edge.from_id),
      ),
      "Unlinked workflow",
    );
    const locator = z
      .discriminatedUnion("kind", [
        z.object({ kind: z.literal("named"), name: text }),
        z.object({ kind: z.literal("file"), source: text }),
      ])
      .parse(JSON.parse(text.parse(workflow.attributes["workflow/definition"])));
    if (locator.kind === "named") assert.equal(locator.name, "parallel");
    else assert.equal(await realpath(locator.source), await realpath(definitionFile));
    const snapshot = z
      .object({ status: text })
      .parse(JSON.parse(text.parse(workflow.attributes["workflow/snapshot"])));
    assert.equal(snapshot.status, "done");
  }
  await Bun.write(join(output, "graphs.json"), JSON.stringify({ cards, runs, graphs }, null, 2));
  assert.equal(
    run.attributes["agent/state"],
    "stopped",
    JSON.stringify(run.attributes["agent/error"]),
  );
  assert.ok(
    cards.some(
      (card) => card.state === "closed" && card.attributes["kanban/progression"] === "children",
    ),
    "No completed child-gated feature",
  );
  assert.ok(
    runs.length > 0 && runs.every((workflow) => workflow.state === "closed"),
    "Workflow roots are not complete",
  );
  assert.equal(await Bun.file(join(workspace, "orders.json")).text(), JSON.stringify(sample));
  assert.equal(await Bun.file(definitionFile).text(), definitionSource);
  for (const filename of ["totals.ts", "totals.test.ts", "README.md"])
    assert.ok(await Bun.file(join(workspace, filename)).exists(), `Missing ${filename}`);
  const tests = await execute(
    [
      "qlock",
      "exec",
      "--lock",
      "/tmp/agent-cpu.lock",
      "-w",
      "180",
      "--",
      "bun",
      "test",
      "totals.test.ts",
    ],
    workspace,
  );
  assert.equal(tests.code, 0, tests.stderr);
  const normal = await execute(["bun", "totals.ts", "orders.json"], workspace);
  assert.equal(normal.code, 0, normal.stderr);
  assert.equal(normal.stdout, '{"totalCents":3350}\n');
  assert.equal(normal.stderr, "");
  const probes: unknown[] = [];
  for (const [name, input, expected] of [
    ["empty", [], 0],
    ["negative", [{ sku: "x", quantity: -1, unitPriceCents: 1 }], null],
    ["fractional", [{ sku: "x", quantity: 0.5, unitPriceCents: 1 }], null],
    ["missing", [{ sku: "x", quantity: 1 }], null],
    ["empty-sku", [{ sku: "", quantity: 1, unitPriceCents: 1 }], null],
  ] as const) {
    const filename = join(workspace, `probe-${name}.json`);
    await Bun.write(filename, JSON.stringify(input));
    const result = await execute(["bun", "totals.ts", filename], workspace);
    if (expected === null) {
      assert.notEqual(result.code, 0, `Accepted ${name}`);
      assert.equal(result.stdout.trim(), "");
      assert.ok(result.stderr.trim().length > 0);
    } else {
      assert.equal(result.code, 0);
      assert.equal(result.stdout, `${JSON.stringify({ totalCents: expected })}\n`);
      assert.equal(result.stderr, "");
    }
    probes.push({ name, ...result });
  }
  await Bun.write(join(workspace, "invalid-json.txt"), "not json");
  for (const file of ["invalid-json.txt", "does-not-exist.json"]) {
    const result = await execute(["bun", "totals.ts", file], workspace);
    assert.notEqual(result.code, 0);
    assert.equal(result.stdout.trim(), "");
    assert.ok(result.stderr.trim().length > 0);
    probes.push({ file, ...result });
  }
  await Bun.write(
    join(output, "verdict.json"),
    JSON.stringify(
      {
        ok: true,
        seat,
        model,
        runId,
        cards: cards.map((card) => card.id),
        workflows: runs.map((workflow) => workflow.id),
        tests,
        normal,
        probes,
        result: run.attributes["agent/result"],
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ ok: true, seat, output }));
} finally {
  try {
    if (runId !== undefined && workspace !== undefined) {
      const run = node.parse(await host.bl(workspace, "agent", { command: "show", id: runId }));
      if (run.attributes["agent/settled"] !== true)
        await host.bl(workspace, "agent", { command: "cancel", id: runId });
    }
  } finally {
    await host.close();
  }
}

async function execute(command: string[], cwd: string) {
  const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe", env: host.env });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}
