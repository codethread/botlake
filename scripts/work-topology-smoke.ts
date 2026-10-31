// Pack/install outside the checkout, exercise topology through the real CLI, and remove the disposable lake.
import assert from "node:assert/strict";

import { z } from "zod";

import { system } from "../tests/blackbox/fixtures/system.ts";

const identifier = z.object({ id: z.string() });
const topologySchema = z.object({
  view: z.enum(["tree", "graph"]),
  root: z.string().nullable(),
  roots: z.array(z.string()),
  direction: z.enum(["children", "prerequisites", "dependents"]),
  nodes: z.array(
    z.looseObject({
      id: z.string(),
      title: z.string(),
      state: z.enum(["open", "closed"]),
      ready: z.boolean().optional(),
      description: z.string().optional(),
      acceptanceCriteria: z
        .array(
          z.object({
            id: z.string(),
            condition: z.string(),
            state: z.enum(["open", "resolved"]),
            resolution: z.object({ text: z.string(), by: z.string(), at: z.string() }).nullable(),
          }),
        )
        .optional(),
    }),
  ),
  edges: z.array(
    z.object({
      from: z.string(),
      to: z.string(),
      relation: z.enum(["parent-of", "depends-on"]),
    }),
  ),
  context: z.array(z.string()),
  components: z.array(z.array(z.string())),
  omittedLinks: z.number(),
});

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface TerminalResult {
  code: number;
  output: string;
}

type SmokeTopology = z.output<typeof topologySchema>;

function topology(value: unknown): SmokeTopology {
  return topologySchema.parse(value);
}

function ids(view: SmokeTopology): string[] {
  return view.nodes.map(({ id }) => id);
}

function edgeKeys(view: SmokeTopology): string[] {
  return view.edges.map(({ from, to }) => `${from}->${to}`).toSorted();
}

const host = await system();
const evidence: string[] = [];
try {
  const workspace = await host.workspace("work-topology-smoke", [
    "@botlake/extension-batteries",
    "@botlake/extension-identity",
    "@botlake/extension-work",
  ]);
  await host.botlake(["lake", "start", "--workspace", workspace]);
  const cli = (args: string[], ok = true) => host.cli(["--workspace", workspace, ...args], ok);
  const create = async (title: string, flags: string[] = []) =>
    identifier.parse(await cli(["work", "create", title, ...flags])).id;
  const failure = async (args: string[], pattern: RegExp) => {
    assert.match(String(await cli(args, false)), pattern);
  };

  const outer = await create("Release", ["--kind", "group", "--description", "Release context"]);
  const inner = await create("Architecture", [
    "--kind",
    "group",
    "--parent",
    outer,
    "--description",
    "Shared engineering context",
  ]);
  const description = `A long local brief: ${"preserve the boundary and explain the decision. ".repeat(18)}\nSecond line\twith a tab and escape\u001B[2J.`;
  const root = await create("Implement \u001B[31mgraph\u001B[0m\nprojection", [
    "--parent",
    inner,
    "--description",
    description,
  ]);
  const left = await create("Left prerequisite", [
    "--parent",
    inner,
    "--description",
    "Left brief",
  ]);
  const right = await create("Right prerequisite", [
    "--parent",
    inner,
    "--description",
    "Right brief",
  ]);
  const common = await create("Shared base", ["--parent", inner, "--description", "Base brief"]);
  const referenced = await create("External reference", ["--kind", "group"]);

  await cli(["work", "link", root, left, "--relation", "depends-on"]);
  await cli(["work", "link", root, right, "--relation", "depends-on"]);
  await cli(["work", "link", left, common, "--relation", "depends-on"]);
  await cli(["work", "link", right, common, "--relation", "depends-on"]);
  await cli(["work", "link", referenced, root, "--relation", "references"]);
  const criterion = identifier.parse(
    await cli([
      "work",
      "criterion",
      "add",
      common,
      "Measure shared-base stability",
      "--by",
      "smoke",
    ]),
  ).id;
  await cli([
    "work",
    "criterion",
    "resolve",
    common,
    criterion,
    "Assessment: stable with no regressions.",
    "--by",
    "reviewer",
  ]);
  await cli(["work", "close", common, "--by", "reviewer"]);

  // The dependency projection keeps canonical dependent -> prerequisite edges, including the diamond join.
  const prerequisites = topology(await cli(["work", "graph", root, "--state", "all"]));
  const diamond = [
    `${root}->${left}`,
    `${root}->${right}`,
    `${left}->${common}`,
    `${right}->${common}`,
  ];
  assert.equal(prerequisites.view, "graph");
  assert.equal(prerequisites.root, root);
  assert.equal(prerequisites.direction, "prerequisites");
  assert.deepEqual(new Set(ids(prerequisites)), new Set([root, left, right, common]));
  assert.deepEqual(edgeKeys(prerequisites), diamond.toSorted());
  assert.deepEqual(prerequisites.roots, [root]);
  assert.equal(prerequisites.components.length, 1);
  assert.deepEqual(new Set(prerequisites.components.flat()), new Set([root, left, right, common]));
  assert.equal(prerequisites.context.length, 0);
  assert.equal(prerequisites.omittedLinks, 0);
  assert.ok(prerequisites.nodes.every((node) => !("description" in node)));
  assert.ok(prerequisites.nodes.every((node) => !("acceptanceCriteria" in node)));
  assert.ok(!ids(prerequisites).includes(referenced));

  const dependents = topology(
    await cli(["work", "graph", common, "--direction", "dependents", "--state", "all"]),
  );
  assert.equal(dependents.direction, "dependents");
  assert.deepEqual(edgeKeys(dependents), diamond.toSorted());
  assert.deepEqual(new Set(ids(dependents)), new Set([root, left, right, common]));
  assert.equal(dependents.roots[0], common);

  const lean = topology(
    await cli([
      "work",
      "graph",
      root,
      "--state",
      "all",
      "--lean",
      "--show-description",
      "--show-criteria",
    ]),
  );
  assert.deepEqual(edgeKeys(lean), diamond.toSorted());
  for (const node of lean.nodes)
    assert.deepEqual(Object.keys(node).toSorted(), ["id", "state", "title"]);

  const expanded = topology(
    await cli(["work", "graph", root, "--state", "all", "--show-description", "--show-criteria"]),
  );
  assert.deepEqual(edgeKeys(expanded), diamond.toSorted());
  assert.equal(expanded.nodes.find(({ id }) => id === root)?.description, description);
  const resolved = expanded.nodes.find(({ id }) => id === common);
  assert.ok(resolved !== undefined && "acceptanceCriteria" in resolved);
  const resolvedCriteria = resolved.acceptanceCriteria;
  assert.ok(resolvedCriteria !== undefined);
  assert.equal(resolvedCriteria[0]?.id, criterion);
  assert.equal(resolvedCriteria[0]?.condition, "Measure shared-base stability");
  assert.equal(resolvedCriteria[0]?.state, "resolved");
  assert.equal(resolvedCriteria[0]?.resolution?.text, "Assessment: stable with no regressions.");
  assert.equal(resolvedCriteria[0]?.resolution?.by, "reviewer");
  assert.match(resolvedCriteria[0]?.resolution?.at ?? "", /^\d{4}-\d{2}-\d{2}T/u);
  evidence.push(
    "full and lean dependency diamonds, canonical traversal, metadata, references excluded",
  );

  // Lifecycle filters never invent edges; an explicit root survives even when it does not match.
  const openGraph = topology(await cli(["work", "graph", root]));
  assert.ok(!ids(openGraph).includes(common));
  assert.deepEqual(edgeKeys(openGraph), [`${root}->${left}`, `${root}->${right}`].toSorted());
  assert.equal(openGraph.omittedLinks, 2);
  assert.equal(openGraph.nodes.find(({ id }) => id === root)?.ready, false);
  assert.equal(openGraph.nodes.find(({ id }) => id === left)?.ready, true);
  assert.equal(openGraph.nodes.find(({ id }) => id === right)?.ready, true);
  const closedGraph = topology(await cli(["work", "graph", root, "--state", "closed"]));
  assert.ok(ids(closedGraph).includes(root));
  assert.ok(ids(closedGraph).includes(common));
  assert.deepEqual(closedGraph.edges, []);
  assert.equal(closedGraph.omittedLinks, 4);
  const allGraph = topology(await cli(["work", "graph", root, "--state", "all"]));
  assert.deepEqual(edgeKeys(allGraph), diamond.toSorted());

  const openTree = topology(await cli(["work", "tree", outer]));
  assert.equal(openTree.direction, "children");
  assert.ok(!ids(openTree).includes(common));
  assert.ok(!ids(openTree).includes(referenced));
  assert.equal(openTree.omittedLinks, 1);
  const closedTree = topology(await cli(["work", "tree", outer, "--state", "closed"]));
  assert.ok(ids(closedTree).includes(outer));
  assert.ok(ids(closedTree).includes(common));
  assert.deepEqual(closedTree.context, [inner]);
  assert.deepEqual(edgeKeys(closedTree), [`${outer}->${inner}`, `${inner}->${common}`].toSorted());
  const allTree = topology(await cli(["work", "tree", outer, "--state", "all"]));
  assert.deepEqual(new Set(ids(allTree)), new Set([outer, inner, root, left, right, common]));
  assert.deepEqual(
    edgeKeys(allTree),
    [
      `${outer}->${inner}`,
      `${inner}->${root}`,
      `${inner}->${left}`,
      `${inner}->${right}`,
      `${inner}->${common}`,
    ].toSorted(),
  );

  const filteredDependents = topology(
    await cli(["work", "graph", common, "--direction", "dependents", "--state", "open"]),
  );
  assert.ok(ids(filteredDependents).includes(common));
  assert.deepEqual(edgeKeys(filteredDependents), diamond.toSorted());
  assert.equal(filteredDependents.omittedLinks, 0);
  evidence.push(
    "open/closed/all filters, explicit roots, tree ancestor context and omitted-link counts",
  );

  // Short aliases must expand the same fields as their long forms.
  const aliases = topology(await cli(["work", "graph", root, "--state", "all", "-sd", "-ss"]));
  assert.equal(aliases.nodes.find(({ id }) => id === root)?.description, description);
  const aliasCriteria = aliases.nodes.find(({ id }) => id === common);
  assert.ok(aliasCriteria?.acceptanceCriteria !== undefined);
  assert.equal(aliasCriteria.acceptanceCriteria[0]?.id, criterion);

  // More than one default page of disconnected items must be returned by one topology query.
  const bulk: string[] = [];
  for (let index = 0; index < 105; index += 1)
    bulk.push(await create(`Bulk topology item ${String(index + 1).padStart(3, "0")}`));
  const unpaged = topology(await cli(["work", "graph", "--state", "all"]));
  assert.ok(unpaged.nodes.length > 100);
  assert.ok(bulk.every((id) => ids(unpaged).includes(id)));
  const forest = topology(await cli(["work", "tree", "--state", "all", "--lean"]));
  assert.equal(forest.root, null);
  assert.ok(forest.roots.includes(outer));
  assert.ok(forest.roots.includes(referenced));
  assert.ok(!forest.roots.includes(inner));
  assert.ok(bulk.every((id) => forest.roots.includes(id)));
  assert.ok(forest.edges.every((edge) => edge.relation === "parent-of"));
  evidence.push("topology returns all 105+ work items without list-page truncation");

  // Raw subprocess output verifies text is genuinely unquoted, and non-TTY defaults stay JSON.
  const rawJson = await runCli(host, ["--workspace", workspace, "work", "tree", outer]);
  assert.equal(rawJson.code, 0, rawJson.stderr);
  assert.equal(topology(JSON.parse(rawJson.stdout)).view, "tree");
  const rawText = await runCli(host, [
    "--workspace",
    workspace,
    "work",
    "graph",
    root,
    "--format",
    "text",
    "--state",
    "all",
    "--show-description",
    "--show-criteria",
  ]);
  assert.equal(rawText.code, 0, rawText.stderr);
  assert.ok(rawText.stdout.startsWith("Prerequisites\n"));
  assert.ok(!rawText.stdout.startsWith('"'));
  assert.ok(rawText.stdout.includes("Assessment: stable with no regressions."));
  assert.ok(
    rawText.stdout.includes("Second line with a tab and escape."),
    JSON.stringify(rawText.stdout),
  );
  assert.ok(!rawText.stdout.includes("\u001B"));
  const componentsText = await runCli(host, [
    "--workspace",
    workspace,
    "work",
    "graph",
    "--lean",
    "--format",
    "text",
    "--state",
    "all",
  ]);
  assert.equal(componentsText.code, 0, componentsText.stderr);
  assert.ok(componentsText.stdout.includes("Component 1\n"));
  assert.ok(componentsText.stdout.includes("Component 2\n"));
  evidence.push("non-TTY JSON default and explicit raw, unquoted text with safe long prose");

  if (process.platform !== "win32") {
    const terminalTree = await runTerminal(host, [
      "--workspace",
      workspace,
      "work",
      "tree",
      outer,
      "--state",
      "all",
    ]);
    assert.equal(terminalTree.code, 0);
    assert.ok(terminalTree.output.startsWith("Containment\n"));
    assert.ok(terminalTree.output.includes("Architecture"));
    assert.ok(terminalTree.output.includes("group · open"));
    assert.match(terminalTree.output, /\n      group · open/u);

    const terminalGraph = await runTerminal(host, [
      "--workspace",
      workspace,
      "work",
      "graph",
      root,
      "--state",
      "all",
    ]);
    assert.equal(terminalGraph.code, 0);
    assert.ok(terminalGraph.output.startsWith("Prerequisites\n"));
    assert.ok(terminalGraph.output.includes("shown above"));
    assert.match(terminalGraph.output, /\n├── Left prerequisite[^\n]*\n│     P2 · open · ready/u);
    assert.match(terminalGraph.output, /\n└── Right prerequisite[^\n]*\n      P2 · open · ready/u);

    const terminalDetails = await runTerminal(host, [
      "--workspace",
      workspace,
      "work",
      "graph",
      root,
      "--state",
      "all",
      "-sd",
      "-ss",
    ]);
    assert.equal(terminalDetails.code, 0);
    assert.ok(terminalDetails.output.includes("Second line with a tab and escape."));
    assert.ok(terminalDetails.output.includes("[resolved] Measure shared-base stability"));
    assert.ok(terminalDetails.output.includes("Assessment: stable with no regressions."));
    assert.ok(!terminalDetails.output.includes("\u001B"));

    const terminalJson = await runTerminal(host, [
      "--workspace",
      workspace,
      "work",
      "graph",
      root,
      "--format",
      "json",
    ]);
    assert.equal(terminalJson.code, 0);
    assert.equal(topology(JSON.parse(terminalJson.output)).view, "graph");
    const forcedJson = await runTerminal(host, [
      "--workspace",
      workspace,
      "--json",
      "work",
      "graph",
      root,
    ]);
    assert.equal(forcedJson.code, 0);
    assert.equal(topology(JSON.parse(forcedJson.output)).view, "graph");
    evidence.push(
      "PTY ASCII tree/graph, repeated-node marker, six-space details, JSON overrides and aliases",
    );
  } else {
    evidence.push("PTY checks skipped on Windows; Bun terminal is unavailable on this platform");
  }

  await failure(
    ["work", "graph", "--direction", "sideways"],
    /direction|prerequisites|dependents/iu,
  );
  await failure(["work", "graph", "--direction", "dependents"], /direction.*id|requires an id/iu);
  await failure(["work", "graph", "missing-work-item"], /not found|missing/iu);
  await failure(["work", "tree", "--state", "active"], /open|closed|all|state/iu);
  await failure(["work", "tree", "--format", "yaml"], /json|text|format/iu);
  evidence.push("invalid direction, missing item, state and output format fail loudly");

  console.log(JSON.stringify({ ok: true, evidence }, null, 2));
} finally {
  await host.close();
}

async function runCli(
  systemHost: Awaited<ReturnType<typeof system>>,
  args: string[],
): Promise<CliResult> {
  const child = Bun.spawn([systemHost.blBin, ...args], {
    cwd: systemHost.dir,
    env: systemHost.env,
    stdin: new Blob([]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

async function runTerminal(
  systemHost: Awaited<ReturnType<typeof system>>,
  args: string[],
): Promise<TerminalResult> {
  const ended = Promise.withResolvers<void>();
  let output = "";
  const decoder = new TextDecoder();
  const child = Bun.spawn([systemHost.blBin, ...args], {
    cwd: systemHost.dir,
    env: { ...systemHost.env, TERM: "xterm-256color", NO_COLOR: "1" },
    terminal: {
      cols: 64,
      rows: 30,
      data(_, bytes) {
        output += decoder.decode(bytes, { stream: true });
      },
      exit() {
        ended.resolve();
      },
    },
  });
  try {
    const [code] = await Promise.all([child.exited, ended.promise]);
    return { code, output: (output + decoder.decode()).replaceAll("\r\n", "\n") };
  } finally {
    child.terminal?.close();
  }
}
