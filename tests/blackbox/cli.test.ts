import { test, expect } from "bun:test";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { system } from "./fixtures/system.ts";

async function runCli(
  host: Awaited<ReturnType<typeof system>>,
  args: string[],
  input = "",
  env: Record<string, string | undefined> = {},
  binary = host.blBin,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([binary, ...args], {
    cwd: host.dir,
    env: { ...host.env, ...env },
    stdin: new Blob([input]),
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
  host: Awaited<ReturnType<typeof system>>,
  args: string[],
  noColor = true,
  binary = host.blBin,
): Promise<{ code: number; output: string }> {
  const ended = Promise.withResolvers<void>();
  let output = "";
  const decoder = new TextDecoder();
  const child = Bun.spawn([binary, ...args], {
    cwd: host.dir,
    env: { ...host.env, TERM: "xterm-256color", NO_COLOR: noColor ? "1" : undefined },
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

test("botlake controls lakes and evaluates scripts while bl commits structured nodes", async () => {
  const host = await system();
  try {
    const workspace = await host.workspace("nodes", ["@botlake/extension-batteries"]);
    await host.botlake(["lake", "start", "--workspace", workspace]);
    const committed = z
      .object({
        refs: z.object({ root: z.string(), child: z.string() }),
        changes: z.array(z.object({ kind: z.enum(["node", "edge"]) })),
      })
      .parse(
        await host.bl("nodes", "batch", {
          nodes: [
            { ref: "root", title: "Root", attributes: { kind: "root" } },
            { ref: "child", title: "Child" },
          ],
          edges: [{ op: "upsert", from: "root", to: "child", relation: "parent-of" }],
        }),
      );
    expect(committed.changes.map(({ kind }) => kind)).toEqual(["node", "node", "edge"]);
    const subgraph = z
      .object({
        nodes: z.array(z.object({ id: z.string() })),
        edges: z.array(z.object({ from_id: z.string(), to_id: z.string(), relation: z.string() })),
      })
      .parse(await host.bl("nodes", "subgraph", { id: committed.refs.root }));
    expect(subgraph.nodes.map(({ id }) => id).toSorted()).toEqual(
      [committed.refs.root, committed.refs.child].toSorted(),
    );
    expect(subgraph.edges).toEqual([
      { from_id: committed.refs.root, to_id: committed.refs.child, relation: "parent-of" },
    ]);
    const evaluated = await runCli(
      host,
      [
        "lake",
        "eval",
        "--workspace",
        "nodes",
        'console.log("diagnostic"); return await api.call("list", {where:q.eq(q.attr("kind"),"root")});',
      ],
      "",
      {},
      host.botlakeBin,
    );
    expect(evaluated.code).toBe(0);
    expect(evaluated.stderr).toContain("diagnostic");
    expect(JSON.parse(evaluated.stdout)).toMatchObject([{ id: committed.refs.root }]);
    const rejected = await runCli(host, ["--workspace", "nodes", "--json", "eval", "return 1;"]);
    expect(rejected.code).toBe(1);
    expect(rejected.stdout).toBe("");
    expect(JSON.parse(rejected.stderr)).toMatchObject({ code: "not-found" });
    await host.botlake(["lake", "restart", "--workspace", workspace]);
    expect(await host.bl("nodes", "show", { id: committed.refs.child })).toMatchObject({
      title: "Child",
    });
  } finally {
    await host.close();
  }
}, 60000);

test("bl preserves payloads, caller-relative files and literal arguments", async () => {
  const host = await system();
  try {
    const workspace = await host.workspace("cli", [
      "@botlake/extension-batteries",
      "./commands.ts",
    ]);
    await Bun.write(
      join(workspace, "commands.ts"),
      `import {defineOp} from "@botlake/core";
import {z} from "zod";
export default {name:"commands",activate(ctx){
  ctx.register(defineOp({name:"echo", input:z.object({value:z.string()}), output:z.string(),
    cli:{description:"echo",flags:{value:{type:"string"}},positionals:[{name:"value",type:"string",required:true}]},
    handler:input=>input.value}));
  ctx.register(defineOp({name:"scalar",input:z.union([z.null(),z.literal(false),z.literal(0),z.literal("")]),
    output:z.json(),cli:{description:"scalar"},handler:input=>input}));
  ctx.register(defineOp({name:"wait",input:z.object({}),output:z.string(),cli:{description:"wait"},
    handler:(_,ctx,request)=>new Promise((resolve,reject)=>{
      request.signal.addEventListener("abort",()=>reject(request.signal.reason),{once:true});
    })}));
}};`,
    );
    await host.botlake(["lake", "start", "--workspace", workspace]);
    await Bun.write(join(host.dir, "message.txt"), "from caller");
    await Bun.write(join(host.dir, "payload.json"), '{"value":"from payload"}');
    expect(await host.cli(["--workspace=cli", "echo", "--value=@message.txt"])).toBe("from caller");
    expect(await host.cli(["--workspace", "cli", "--input=@payload.json", "echo"])).toBe(
      "from payload",
    );
    for (const value of ["--workspace", "--timeout"]) {
      expect(await host.cli(["--workspace", "cli", "echo", "--", value])).toBe(value);
    }
    for (const value of [null, false, 0, ""]) {
      expect(await host.bl("cli", "scalar", value)).toBe(value);
    }
    expect(await host.cli(["--workspace", "cli", "--timeout=1ms", "wait"], false)).toContain(
      "deadline",
    );

    const invalid: unknown = JSON.parse(
      await host.wire({
        protocol_version: 1,
        request_id: "invalid-invoke",
        operation: "invoke",
        workspace: "cli",
        payload: null,
      }),
    );
    expect(invalid).toMatchObject({
      ok: false,
      error: { message: "invoke payload must be an object" },
    });
    expect(await host.bl("cli", "echo", { value: "still running" })).toBe("still running");
    const root = z
      .object({ id: z.string() })
      .parse(await host.cli(["--workspace", "cli", "add", "Root"]));
    const child = z
      .object({ id: z.string() })
      .parse(await host.cli(["--workspace", "cli", "add", "Dependency"]));
    await host.cli(["--workspace", "cli", "edge", "add", root.id, child.id, "depends-on"]);
    expect(
      z
        .object({ nodes: z.array(z.object({ id: z.string() })) })
        .parse(
          await host.cli(["--workspace", "cli", "subgraph", root.id, "--relation", "depends-on"]),
        )
        .nodes.map((entry) => entry.id)
        .toSorted(),
    ).toEqual([root.id, child.id].toSorted());
    const shippedHelp = await runTerminal(host, ["--workspace", "cli", "prime", "update"]);
    expect(shippedHelp.code).toBe(0);
    expect(shippedHelp.output).toContain("--expected-revision");
    expect(shippedHelp.output).toContain("Runbook");
  } finally {
    await host.close();
  }
}, 60000);

test("declared bins build and execute locally with caller I/O, cwd, environment, arguments and TTY", async () => {
  const host = await system();
  try {
    const workspace = await host.workspace("executables", ["./bins.ts"]);
    const executable = join(workspace, "probe");
    await Bun.write(
      join(workspace, "probe-source"),
      `#!/usr/bin/env bun
const tty = process.stdin.isTTY === true;
console.log(JSON.stringify({cwd:process.cwd(),input:tty?null:await Bun.stdin.text(),args:process.argv.slice(2),env:process.env.BIN_VALUE,tty,columns:process.stdout.columns??null}));
process.exit(Number(process.env.BIN_EXIT??0));
`,
    );
    await Bun.write(
      join(workspace, "bins.ts"),
      `export default {name:"bins-fixture",activate(ctx){
      ctx.bin("probe",{description:"Inspect the caller",exec:{path:${JSON.stringify(executable)},env:{BIN_VALUE:"declared"}},build:{argv:["sh","-c","cp probe-source probe && chmod +x probe"],cwd:${JSON.stringify(workspace)}}});
      ctx.bin("cat",{description:"Copy stdin",exec:{command:"cat"}});
      ctx.bin("missing",{description:"Missing executable",exec:{command:"botlake-missing-command"}});
      ctx.bin("failed-build",{description:"Failed build",exec:{path:${JSON.stringify(join(workspace, "missing"))}},build:{argv:["sh","-c","exit 9"],cwd:${JSON.stringify(workspace)}}});
    }};`,
    );
    await host.botlake(["lake", "start", "--workspace", workspace]);
    expect(
      await host.botlake(["bin", "run", "--workspace", "executables", "probe"], false),
    ).toContain("not built");
    expect(
      await host.botlake(["bin", "build", "--workspace", "executables", "probe"]),
    ).toMatchObject({
      exit: 0,
    });
    const args = ["--workspace", "literal", "@not-a-file", ":stdin", "--", "", "--help"];
    const child = Bun.spawn(
      [host.botlakeBin, "bin", "run", "--workspace", "executables", "probe", ...args],
      {
        cwd: host.dir,
        env: { ...host.env, BIN_VALUE: "caller", BIN_EXIT: "7" },
        stdin: new Blob(["raw stdin\n"]),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code).toBe(7);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual({
      cwd: await realpath(host.dir),
      input: "raw stdin\n",
      args,
      env: "declared",
      tty: false,
      columns: null,
    });
    const terminal = await runTerminal(
      host,
      ["bin", "run", "--workspace", "executables", "probe"],
      true,
      host.botlakeBin,
    );
    expect(terminal.code).toBe(0);
    expect(JSON.parse(terminal.output)).toMatchObject({ tty: true, columns: 64, input: null });
    const cat = Bun.spawn([host.botlakeBin, "bin", "--workspace", "executables", "run", "cat"], {
      cwd: host.dir,
      env: host.env,
      stdin: new Blob(["unquoted text\n"]),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await new Response(cat.stdout).text()).toBe("unquoted text\n");
    expect(await cat.exited).toBe(0);
    expect(
      await host.botlake(["bin", "build", "--workspace", "executables", "cat"], false),
    ).toContain("no build recipe");
    expect(
      await host.botlake(["bin", "build", "--workspace", "executables", "failed-build"], false),
    ).toContain("exit status 9");
    expect(
      await host.botlake(["bin", "run", "--workspace", "executables", "missing"], false),
    ).toContain("executable file not found");
    expect(
      await host.botlake(["bin", "run", "--workspace", "executables", "unknown"], false),
    ).toContain("Unknown bin");
  } finally {
    await host.close();
  }
}, 60000);

test("botlake init bootstraps a fresh empty workspace without replacing selected configuration", async () => {
  const host = await system();
  try {
    const workspace = join(host.dir, "fresh-project");
    await mkdir(workspace);
    expect(await host.botlake(["init", "--workspace", workspace, "--name", "fresh"])).toMatchObject(
      {
        created: true,
        name: "fresh",
      },
    );
    const config = Bun.file(join(workspace, ".botlake/package.json"));
    expect(await config.json()).toEqual({
      private: true,
      type: "module",
      botlake: { name: "fresh", extensions: [] },
    });
    await host.botlake(["lake", "start", "--workspace", workspace]);
    expect(await host.cli(["--workspace", "fresh", "bins", "list"])).toMatchObject({ bins: [] });
    await host.botlake(["lake", "stop", "--workspace", "fresh"]);
    await Bun.write(
      config,
      '{"private":true,"botlake":{"name":"renamed","extensions":["./selected.ts"]}}\n',
    );
    expect(await host.botlake(["init", "--workspace", workspace])).toMatchObject({
      created: false,
      name: "renamed",
    });
    expect(await config.text()).toBe(
      '{"private":true,"botlake":{"name":"renamed","extensions":["./selected.ts"]}}\n',
    );
    expect(
      await host.botlake(["init", "--workspace", workspace, "--name", "other"], false),
    ).toContain("already exists");
  } finally {
    await host.close();
  }
}, 60000);

test("stdin, named payloads, context flags and dry-run stay thin while operation flags remain opaque", async () => {
  const host = await system();
  try {
    const workspace = await host.workspace("payloads", ["./commands.ts"]);
    await Bun.write(
      join(workspace, "commands.ts"),
      `import {defineOp} from "@botlake/core";
import {z} from "zod";
export default {name:"payloads",activate(ctx){
  ctx.register(defineOp({name:"echo",input:z.object({value:z.string()}),output:z.string(),
    cli:{description:"Echo text",positionals:[{name:"value",type:"string",required:true}]},handler:input=>input.value}));
  ctx.register(defineOp({name:"json",input:z.object({value:z.json()}),output:z.json(),
    cli:{description:"JSON",flags:{value:{type:"json",required:true}}},handler:input=>input.value}));
  ctx.register(defineOp({name:"owned",input:z.object({workspace:z.string(),timeout:z.string()}),output:z.json(),
    cli:{description:"Extension-owned flags",flags:{workspace:{type:"string",required:true},timeout:{type:"string",required:true}}},handler:input=>input}));
  ctx.register(defineOp({name:"context",input:z.object({}),output:z.json(),cli:{description:"Invocation context"},
    handler:(_,ctx,request)=>({cwd:request.cwd,root:request.worktreeRoot??null,common:request.gitCommonDir??null,terminal:request.terminal})}));
}};`,
    );
    await host.botlake(["lake", "start", "--workspace", workspace]);
    const prefix = ["--workspace", "payloads"];
    expect(
      await runCli(host, [...prefix, "--stdin", "echo", ":stdin"], "line one\nline two\n"),
    ).toEqual({ code: 0, stdout: '"line one\\nline two\\n"\n', stderr: "" });
    expect(await runCli(host, [...prefix, "--stdin", "echo", ":stdin"])).toEqual({
      code: 0,
      stdout: '""\n',
      stderr: "",
    });
    await Bun.write(join(host.dir, "object.json"), '{"answer":42}');
    expect(
      await host.cli([
        ...prefix,
        "--payload",
        "body=object.json",
        "json",
        "--value",
        ":payload/body",
      ]),
    ).toEqual({ answer: 42 });
    const nested = await runCli(
      host,
      [...prefix, "--stdin", "json", "--value", '{"body":":stdin"}'],
      "raw text",
    );
    expect(JSON.parse(nested.stdout)).toEqual({ body: "raw text" });
    expect(
      await host.cli([...prefix, "owned", "--workspace", "domain", "--timeout", "domain-time"]),
    ).toEqual({ workspace: "domain", timeout: "domain-time" });
    expect((await runCli(host, [...prefix, "--stdin", "echo", "unused"], "text")).stderr).toContain(
      "Unused payload",
    );
    expect((await runCli(host, [...prefix, "--stdin", "help"], "text")).stderr).toContain(
      "Unused payload",
    );
    expect(await host.cli([...prefix, "echo", ":payload/missing"], false)).toContain(
      "Missing payload",
    );
    expect(
      (
        await runCli(host, [
          ...prefix,
          "--stdin",
          "--payload",
          "stdin=object.json",
          "echo",
          ":stdin",
        ])
      ).stderr,
    ).toContain("duplicate payload slot");
    expect((await runCli(host, [...prefix, "--input", "-", "json"], '{"value":null}')).stdout).toBe(
      "null\n",
    );
    expect((await runCli(host, [...prefix, "--json", "--input", "{bad", "json"])).stderr).toContain(
      '"code":"cli"',
    );

    const nestedDir = join(workspace, "nested");
    await mkdir(nestedDir);
    const context = await host.cli([
      ...prefix,
      "--cwd",
      nestedDir,
      "--worktree-root",
      workspace,
      "--git-common-dir",
      join(workspace, ".git"),
      "context",
    ]);
    expect(context).toEqual({
      cwd: await realpath(nestedDir),
      root: workspace,
      common: join(workspace, ".git"),
      terminal: { isTTY: false, columns: null },
    });
    const terminalContext = await runTerminal(host, [...prefix, "--json", "context"]);
    expect(terminalContext.code).toBe(0);
    expect(JSON.parse(terminalContext.output)).toMatchObject({
      terminal: { isTTY: true, columns: 64 },
    });
    const dry = await runCli(
      host,
      ["--workspace", "not-running", "--stdin", "--dry-run", "echo", ":stdin"],
      "attached",
    );
    expect(dry.code).toBe(0);
    expect(JSON.parse(dry.stdout)).toMatchObject({
      request_id: "<dry-run>",
      operation: "invoke",
      workspace: "not-running",
      payload: { name: "echo", argv: [":stdin"], payloads: { stdin: "attached" }, is_tty: false },
    });
    const unavailable = { BOTLAKE_HOME: join(host.dir, "absent") };
    expect((await runCli(host, ["--help"], "", unavailable)).stdout).toContain("--stdin");
    expect(
      JSON.parse((await runCli(host, ["--json", "--help"], "", unavailable)).stdout),
    ).toContain("--stdin");
    expect((await runCli(host, [], "", unavailable)).code).toBe(0);
    expect(JSON.parse((await runCli(host, ["--version"], "", unavailable)).stdout)).toMatchObject({
      protocol_version: 1,
    });
    const error = await runCli(host, [...prefix, "unknown"], "", {
      BOTLAKE_ERROR_FORMAT: "json",
    });
    expect(error.code).toBe(1);
    expect(error.stdout).toBe("");
    expect(JSON.parse(error.stderr)).toMatchObject({ type: "error", code: "not-found" });
  } finally {
    await host.close();
  }
}, 60000);

test("nested discovery renders for real terminals and stays machine-readable when piped or explicitly requested", async () => {
  const host = await system();
  try {
    const workspace = await host.workspace("help", ["./commands.ts"]);
    await Bun.write(
      join(workspace, "commands.ts"),
      `import {defineOp} from "@botlake/core";
import {z} from "zod";
const input=z.object({area:z.literal("bundle"),action:z.literal("collect"),count:z.number().int().positive(),ids:z.array(z.string()),tag:z.array(z.string()).default([])});
const output=z.json();
export default {name:"help",activate(ctx){ctx.register(defineOp({name:"nested",input,output,jsonSchema:{input,output},
  about:"Collect explicitly selected items into a bundle.",primer:"Choose items first. Inspect the result before publishing.",
  cli:{description:"Bundle operations",selector:"area",commands:{group:{description:"Manage bundles",value:"bundle",selector:"action",commands:{take:{
    description:"Collect named items with optional labels",value:"collect",examples:["bl nested group take --count 2 first second"],
    flags:{count:{type:"number",required:true,description:"Number of items to collect"},tag:{type:"string",multiple:true,description:"Labels applied to the bundle"}},
    positionals:[{name:"item",key:"ids",type:"string",multiple:true,required:true,description:"Items to include"}]
  }}}}},handler:input=>input}));}};`,
    );
    await host.botlake(["lake", "start", "--workspace", workspace]);
    const prefix = ["--workspace", "help"];
    expect(
      await host.cli([
        ...prefix,
        "nested",
        "group",
        "take",
        "--count",
        "2",
        "--tag",
        "one",
        "--tag=two",
        "a",
        "b",
      ]),
    ).toEqual({
      area: "bundle",
      action: "collect",
      count: 2,
      tag: ["one", "two"],
      ids: ["a", "b"],
    });
    expect(await host.cli([...prefix, "nested", "group", "take", "a"], false)).toContain(
      "Required flag",
    );
    expect(
      await host.cli([...prefix, "nested", "group", "take", "--count=", "a"], false),
    ).toContain("Expected a number");
    expect(
      await host.cli([...prefix, "nested", "group", "take", "--count=2", "--count=3", "a"], false),
    ).toContain("Repeated flag");
    const catalog = z.array(z.object({ name: z.string() }));
    expect(catalog.parse(await host.cli([...prefix, "help"]))).toEqual([
      { name: "bins" },
      { name: "nested" },
    ]);
    const leaf = await host.cli([...prefix, "help", "nested", "group", "take"]);
    expect(leaf).toMatchObject([
      { name: "nested", cli: { description: "Collect named items with optional labels" } },
    ]);
    expect(await host.cli([...prefix, "nested", "group", "take", "--help"])).toEqual(leaf);
    for (const tier of ["about", "prime", "primer"]) {
      expect(await host.cli([...prefix, tier, "nested", "group", "take"])).toMatchObject([
        {
          about: "Collect explicitly selected items into a bundle.",
          jsonSchema: { input: { properties: { count: { type: "integer" } } } },
        },
      ]);
    }
    const human = await runTerminal(host, [...prefix, "help", "nested", "group", "take"]);
    expect(human.code).toBe(0);
    for (const text of [
      "Usage",
      "Arguments",
      "Flags",
      "Examples",
      "--count",
      "required",
      "repeatable",
    ])
      expect(human.output).toContain(text);
    expect(human.output).not.toContain("\u001B[");
    expect(human.output.trimStart().startsWith("[")).toBe(false);
    expect((await runTerminal(host, [...prefix, "help", "nested"], false)).output).toContain(
      "\u001B[",
    );
    expect((await runTerminal(host, [...prefix, "prime", "nested"])).output).toContain(
      "Choose items first.",
    );
    const machine = await runTerminal(host, [
      ...prefix,
      "--json",
      "help",
      "nested",
      "group",
      "take",
    ]);
    expect(JSON.parse(machine.output)).toEqual(leaf);
    expect(await host.cli([...prefix, "help", "--json", "nested", "group", "take"])).toEqual(leaf);
  } finally {
    await host.close();
  }
}, 60000);
