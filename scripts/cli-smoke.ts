import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import { cp } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { source, system } from "../tests/blackbox/fixtures/system.ts";
import { writeWorkflowExtension } from "../tests/blackbox/fixtures/workflows.ts";

const commandSchema: z.ZodType<Command> = z.lazy(() =>
  z.object({
    description: z.string().min(1),
    commands: z.record(z.string(), commandSchema).optional(),
  }),
);
interface Command {
  description: string;
  commands?: Record<string, Command> | undefined;
}
const helpSchema = z.array(z.object({ name: z.string(), cli: commandSchema }));
const identifier = z.object({ id: z.string() });
const binding = z.object({ identity: z.string(), runId: z.string() });
const nodePage = z.object({
  nodes: z.array(z.object({ id: z.string(), title: z.string(), state: z.string() })),
  total: z.number(),
  nextOffset: z.number().nullable(),
});
const identityPageSchema = z.object({
  identities: z.array(
    z.strictObject({
      identity: z.string(),
      nodeId: z.string(),
      provider: z.string(),
      activity: z.string(),
      observedAt: z.number().nullable(),
    }),
  ),
  total: z.number(),
  nextOffset: z.number().nullable(),
});
const expected = [
  "agent",
  "await",
  "batch",
  "bins",
  "cron",
  "diary",
  "edge",
  "events",
  "flag",
  "gate",
  "identity",
  "node",
  "query",
  "work",
  "work-agent",
  "workflow",
].toSorted();
// Pack/install outside the checkout. The source lake is read-only; mutations target copies.
const host = await system();
const measurements: Record<string, unknown> = {};
try {
  await auditOfflineHelp();
  const fresh = await host.workspace("cli-smoke", [
    "@botlake/extension-batteries",
    "@botlake/extension-identity",
    "@botlake/extension-diary",
    "@botlake/extension-flags",
    "@botlake/extension-agents",
    "@botlake/extension-work",
    "./work-agents.ts",
    "./workflow-extension.ts",
    "@botlake/extension-cron",
  ]);
  await Bun.write(
    join(fresh, "work-agents.ts"),
    'import {workAgents} from "@botlake/extension-work-agents"; export default workAgents({checkIntervalMs:60000});',
  );
  await writeWorkflowExtension(fresh, ["@botlake/extension-workflow/examples/parallel"]);
  await host.botlake(["lake", "start", "--workspace", fresh]);
  await audit("cli-smoke");
  await exercise("cli-smoke", fresh);

  const clone = await host.workspace("cli-clone", []);
  await cp(join(source, ".botlake"), join(clone, ".botlake"), {
    recursive: true,
    filter: (path) =>
      !["node_modules", "world.db", "world.db-wal", "world.db-shm"].includes(
        path.split("/").at(-1) ?? "",
      ),
  });
  // serialize() uses SQLite's consistent online backup, including committed WAL data.
  const database = new Database(join(source, ".botlake/world.db"), { readonly: true });
  try {
    await Bun.write(join(clone, ".botlake/world.db"), database.serialize());
  } finally {
    database.close();
  }
  const manifest = z
    .looseObject({ botlake: z.looseObject({ extensions: z.array(z.string()) }) })
    .parse(await Bun.file(join(clone, ".botlake/package.json")).json());
  await Bun.write(
    join(clone, ".botlake/package.json"),
    JSON.stringify({
      ...manifest,
      botlake: {
        ...manifest.botlake,
        name: "cli-clone",
        extensions: manifest.botlake.extensions.map((extension) =>
          extension === "./.botlake/src/workflow.ts" ? "./workflow-extension.ts" : extension,
        ),
      },
    }),
  );
  await writeWorkflowExtension(clone, ["@botlake/extension-workflow/examples/parallel"]);
  await host.botlake(["lake", "start", "--workspace", clone]);
  await audit("cli-clone");
  const cloned = nodePage.parse(await call("cli-clone", "node", { command: "list", limit: 3 }));
  assert.ok(cloned.total > 0, "The cloned lake must retain real data");
  measurements["cloneNodes"] = cloned.total;
  await exercise("cli-clone", clone);
  console.log(JSON.stringify({ ok: true, measurements }));
} finally {
  await host.close();
}

async function auditOfflineHelp(): Promise<void> {
  const paths = [
    ["init"],
    ["start"],
    ["status"],
    ["stop"],
    ["restart-host"],
    ["host-status"],
    ["completions"],
    ["completions", "zsh"],
    ["lake"],
    ...["start", "restart", "stop", "status", "list", "eval"].map((name) => ["lake", name]),
    ["bin"],
    ...["list", "build", "run"].map((name) => ["bin", name]),
  ];
  const commands = [
    ["--help"],
    ["help"],
    ["bin", "--help", "build", "never-execute"],
    ...paths.flatMap((path) => [
      [...path, "--help"],
      ["help", ...path],
    ]),
  ];
  for (const args of commands) {
    const process = Bun.spawn([host.botlakeBin, ...args], {
      env: { ...host.env, BL_HOME: join(host.dir, "offline") },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    assert.equal(code, 0, `${args.join(" ")}: ${stderr}`);
    assert.ok(stdout.includes("Usage:"));
    assert.equal(stderr, "");
  }
  measurements["offlineHelpPaths"] = commands.length;
}

async function call(workspace: string, op: string, input: unknown): Promise<unknown> {
  return host.bl(workspace, op, input);
}

async function audit(workspace: string): Promise<void> {
  const root = await host.cli(["--workspace", workspace, "help"]);
  const operations = helpSchema.parse(root);
  assert.deepEqual(operations.map(({ name }) => name).toSorted(), expected);
  let leaves = 0;
  let helpBytes = 0;
  let schemaBytes = 0;
  for (const { name } of operations) {
    for (const tier of ["about", "prime", "schema"]) {
      const detail = await host.cli(["--workspace", workspace, tier, name]);
      if (tier === "schema") {
        assert.notEqual(
          z.array(z.object({ jsonSchema: z.unknown() })).parse(detail)[0]?.jsonSchema,
          null,
        );
        schemaBytes += bytes(detail);
        const contract = z
          .array(
            z.object({
              jsonSchema: z.object({ input: z.looseObject({}), output: z.looseObject({}) }),
            }),
          )
          .parse(detail)[0];
        assert.ok(contract !== undefined);
        if (name === "flag") {
          const input = z.fromJSONSchema(contract.jsonSchema.input);
          assert.ok(input.safeParse({ command: "reset", name: "smoke/flag" }).success);
          assert.ok(input.safeParse({ command: "reset", all: true }).success);
          assert.equal(input.safeParse({ command: "reset" }).success, false);
          assert.equal(
            input.safeParse({ command: "reset", name: "smoke/flag", all: true }).success,
            false,
          );
          assert.equal(z.fromJSONSchema(contract.jsonSchema.output).safeParse(true).success, false);
        }
        if (name === "work-agent")
          assert.equal(
            z
              .object({ type: z.literal("object"), required: z.array(z.string()).length(5) })
              .parse(contract.jsonSchema.output).type,
            "object",
          );
        if (name === "diary") {
          const input = z.fromJSONSchema(contract.jsonSchema.input);
          assert.equal(input.safeParse({ command: "add", text: " \t\n" }).success, false);
          const text = "  raw text \n";
          assert.equal(
            z.object({ text: z.string() }).parse(input.parse({ command: "add", text })).text,
            text,
          );
        }
      }
    }
    await visit([name]);
  }
  measurements[`${workspace}/discovery`] = {
    operations: operations.length,
    leaves,
    rootBytes: bytes(root),
    helpBytes,
    schemaBytes,
  };

  async function visit(path: string[]): Promise<void> {
    const args = ["--workspace", workspace];
    const result = await host.cli([...args, "help", ...path]);
    assert.ok(!JSON.stringify(result).includes('"jsonSchema"'));
    assert.deepEqual(await host.cli([...args, ...path, "--help"]), result);
    helpBytes += bytes(result);
    if (path.length === 1) measurements[`${workspace}/help/${path[0]}`] = bytes(result);
    const command = helpSchema.parse(result)[0]?.cli;
    assert.ok(command !== undefined);
    if (command.commands === undefined) leaves++;
    else for (const name of Object.keys(command.commands)) await visit([...path, name]);
  }
}

async function exercise(workspace: string, cwd: string): Promise<void> {
  const long = "Heavy smoke payload\n".repeat(2500);
  const marker = crypto.randomUUID();
  const created = identifier.parse(
    await call(workspace, "node", { command: "add", title: marker, attributes: { marker, long } }),
  );
  for (let i = 0; i < 5; i++)
    await call(workspace, "node", { command: "add", title: marker, attributes: { marker, long } });
  // Public eval supplies predicate builders, avoiding dependence on their wire representation.
  const evaluate = (body: string) => host.botlake(["lake", "eval", "--workspace", workspace, body]);
  const pages = z.object({ first: nodePage, second: nodePage }).parse(
    await evaluate(`
    const input={command:"list",where:q.eq(q.attr("marker"),${JSON.stringify(marker)}),limit:3};
    const first=await api.call("node",input);
    const second=await api.call("node",{...input,offset:first.nextOffset});
    return {first,second};`),
  );
  assert.equal(pages.first.total, 6);
  assert.equal(pages.first.nextOffset, 3);
  assert.equal(pages.second.nextOffset, null);
  assert.equal(new Set([...pages.first.nodes, ...pages.second.nodes].map(({ id }) => id)).size, 6);
  const summary = await call(workspace, "node", { command: "list", limit: 3 });
  assert.ok(!JSON.stringify(summary).includes(JSON.stringify(long).slice(1, -1)));
  const full = await call(workspace, "node", { command: "show", id: created.id });
  assert.ok(JSON.stringify(full).includes(JSON.stringify(long).slice(1, -1)));
  const expanded = await evaluate(
    `return await api.call("node",{command:"list",where:q.eq(q.attr("marker"),${JSON.stringify(marker)}),lean:false,limit:1});`,
  );
  assert.ok(JSON.stringify(expanded).includes(JSON.stringify(long).slice(1, -1)));
  measurements[`${workspace}/nodeBytes`] = {
    summary: bytes(summary),
    detail: bytes(full),
  };

  const targets = [...pages.first.nodes, ...pages.second.nodes].filter(
    ({ id }) => id !== created.id,
  );
  await call(workspace, "batch", {
    refs: { root: created.id, first: targets[0]?.id, second: targets[1]?.id },
    edges: [
      { op: "upsert", from: "root", to: "first", relation: "smoke", attributes: { long } },
      { op: "upsert", from: "root", to: "second", relation: "smoke", attributes: { long } },
    ],
  });
  const edgePage = await call(workspace, "edge", {
    command: "list",
    id: created.id,
    relation: "smoke",
    limit: 1,
  });
  assert.deepEqual(z.object({ total: z.number(), nextOffset: z.number() }).parse(edgePage), {
    total: 2,
    nextOffset: 1,
  });
  assert.ok(!JSON.stringify(edgePage).includes(JSON.stringify(long).slice(1, -1)));
  const edgeDetail = await call(workspace, "edge", {
    command: "list",
    id: created.id,
    relation: "smoke",
    lean: false,
    limit: 1,
  });
  assert.ok(JSON.stringify(edgeDetail).includes(JSON.stringify(long).slice(1, -1)));

  const native = binding.parse(
    await call(workspace, "agent", {
      command: "native",
      provider: "pi",
      nativeSessionId: marker,
      audience: "agent",
      cwd,
    }),
  );
  const known = [native.identity];
  for (const suffix of ["second", "third"])
    known.push(
      z.object({ identity: z.string() }).parse(
        await call(workspace, "identity", {
          command: "startup",
          provider: "pi",
          nativeSessionId: `${marker}/${suffix}`,
        }),
      ).identity,
    );
  const blocked = await host.bl(
    workspace,
    "node",
    { command: "add", title: "Invalid identity", attributes: { "identity/session": true } },
    false,
  );
  assert.match(z.string().parse(blocked), /identity-guard/u);
  const identityPage = identityPageSchema.parse(
    await call(workspace, "identity", { command: "list", limit: 2 }),
  );
  measurements[`${workspace}/identityPageBytes`] = bytes(identityPage);
  assert.ok(identityPage.total >= 3);
  assert.equal(identityPage.nextOffset, 2);
  const identities = [...identityPage.identities];
  let nextOffset: number | null = identityPage.nextOffset;
  while (nextOffset !== null) {
    const page = identityPageSchema.parse(
      await call(workspace, "identity", { command: "list", limit: 100, offset: nextOffset }),
    );
    assert.equal(page.total, identityPage.total);
    assert.ok(page.nextOffset === null || page.nextOffset > nextOffset);
    identities.push(...page.identities);
    nextOffset = page.nextOffset;
  }
  assert.equal(identities.length, identityPage.total);
  assert.equal(new Set(identities.map(({ identity }) => identity)).size, identityPage.total);
  for (const identity of known) assert.ok(identities.some((entry) => entry.identity === identity));
  await call(workspace, "identity", { command: "show", identity: native.identity });
  const entry = identifier.parse(
    await call(workspace, "diary", { command: "add", identity: native.identity, text: long }),
  );
  await call(workspace, "diary", {
    command: "add",
    identity: native.identity,
    text: "Second entry",
  });
  const diary = await call(workspace, "diary", {
    command: "list",
    identity: native.identity,
    limit: 1,
  });
  assert.ok(!JSON.stringify(diary).includes(JSON.stringify(long).slice(1, -1)));
  const cursor = z.object({ nextCursor: z.string() }).parse(diary).nextCursor;
  const nextDiary = await call(workspace, "diary", {
    command: "list",
    identity: native.identity,
    after: cursor,
    limit: 1,
  });
  assert.equal(z.object({ nextCursor: z.null() }).parse(nextDiary).nextCursor, null);
  assert.ok(
    JSON.stringify(await call(workspace, "diary", { command: "show", id: entry.id })).includes(
      JSON.stringify(long).slice(1, -1),
    ),
  );
  const task = identifier.parse(
    await call(workspace, "work", {
      command: "create",
      title: marker,
      description: long,
      assignee: native.identity,
      by: native.identity,
    }),
  );
  const work = await call(workspace, "work", { command: "list", limit: 3 });
  assert.ok(!JSON.stringify(work).includes(JSON.stringify(long).slice(1, -1)));
  assert.ok(
    JSON.stringify(await call(workspace, "work", { command: "show", id: task.id })).includes(
      JSON.stringify(long).slice(1, -1),
    ),
  );
  const assignment = z.object({ assignment: z.object({ id: z.string() }) }).parse(
    await call(workspace, "work", {
      command: "claim",
      id: task.id,
      assignee: native.identity,
      by: native.identity,
    }),
  ).assignment.id;
  await call(workspace, "work-agent", {
    command: "bind",
    task: task.id,
    run: native.runId,
    assignment,
  });
  await call(workspace, "work-agent", {
    command: "heartbeat",
    task: task.id,
    run: native.runId,
    assignment,
    byIdentity: native.identity,
  });
  await call(workspace, "workflow", { command: "catalog" });
  await call(workspace, "workflow", { command: "catalog", name: "parallel" });
  const workflow = z
    .object({ run: identifier, tasks: z.array(identifier) })
    .parse(await call(workspace, "workflow", { command: "start", name: "parallel", input: {} }));
  await call(workspace, "workflow", { command: "show", id: workflow.run.id });
  await call(workspace, "workflow", { command: "show", id: workflow.tasks[0]?.id });
  await call(workspace, "workflow", {
    command: "complete",
    id: workflow.tasks[0]?.id,
    choice: "next",
    data: {},
  });
  await call(workspace, "agent", { command: "list", limit: 2 });
  await call(workspace, "agent", { command: "show", id: native.runId });
  await call(workspace, "agent", {
    command: "activity",
    operation: "peek",
    id: native.runId,
    limit: 1,
  });
  await call(workspace, "flag", {
    command: "set",
    name: "smoke/flag",
    value: true,
    description: "Disposable smoke flag",
  });
  await call(workspace, "flag", { command: "get", name: "smoke/flag" });
  await call(workspace, "flag", { command: "reset", name: "smoke/flag" });
  const events = z
    .array(z.object({ name: z.string() }))
    .parse(await call(workspace, "events", { command: "list" }));
  assert.ok(!JSON.stringify(events).includes('"schema"'));
  await call(workspace, "events", { command: "show", name: events[0]?.name });
  await call(workspace, "bins", { command: "list" });
  const cronPage = z.object({
    items: z.array(z.json()),
    total: z.number(),
    nextOffset: z.number().nullable(),
  });
  for (const command of ["status", "history"])
    for (const details of [false, true])
      cronPage.parse(await call(workspace, "cron", { command, limit: 1, details }));
  const queries = await call(workspace, "query", {});
  assert.ok(!JSON.stringify(queries).includes('"where"'));
  await call(workspace, "query", { name: "node-active" });
  assert.equal(
    z.object({ reason: z.string() }).parse(
      await call(workspace, "await", {
        query: "node-active",
        params: { id: created.id },
        minCount: 1,
        timeoutSecs: 0,
      }),
    ).reason,
    "satisfied",
  );
  const failure = await host.cli(
    ["--workspace", workspace, "--json", "node", "show", "not-a-node"],
    false,
  );
  assert.equal(
    z.object({ code: z.string() }).parse(JSON.parse(z.string().parse(failure))).code,
    "not-found",
  );
}

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}
