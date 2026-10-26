import { test, expect } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { Runtime, type Context } from "@millstrand/core";
import { z } from "zod";

import { system, install } from "./fixtures/system.ts";

test("external Bun package imports stay inert; worker deps, cleanup, wire streams, deadlines and peer links work", async () => {
  const host = await system();
  try {
    const library = join(host.dir, "library");
    await mkdir(library);
    const marker = join(library, "lifecycle");
    await Bun.write(
      join(library, "package.json"),
      JSON.stringify({
        name: "outside-spool",
        type: "module",
        exports: "./index.ts",
        dependencies: {
          ...Object.fromEntries(
            Object.entries(host.packages).filter(([name]) => name === "@millstrand/core"),
          ),
          zod: "^4.6.7",
        },
      }),
    );
    await Bun.write(
      join(library, "index.ts"),
      `import {defineOp} from "@millstrand/core";import {z} from "zod";
export const op=defineOp({name:"echo",input:z.object({value:z.string()}),output:z.string(),cli:{description:"echo",positionals:[{name:"value",type:"string",required:true}]},handler:input=>input.value});
export default {name:"outside",activate(ctx){ctx.register(op);ctx.register(defineOp({name:"issues",input:{"~standard":{version:1,vendor:"fixture",validate:()=>({issues:[{message:"invalid",path:[Symbol("field")]}]})}},output:z.string(),cli:{description:"issues"},handler:()=>"never"}));ctx.register(defineOp({name:"success-stream",input:z.object({}),output:z.number(),stream:true,cli:{description:"stream"},async *handler(){yield 1;yield 2;}}));ctx.bin("say",{description:"External executable",exec:{command:"echo"}});ctx.register(defineOp({name:"numbers",input:z.object({}),output:z.number().positive(),stream:true,cli:{description:"numbers"},async *handler(){yield 1;yield 2;yield 0;}}));ctx.register(defineOp({name:"wait",input:z.object({}),output:z.string(),cli:{description:"wait"},async handler(_,ctx,request){await new Promise((resolve,reject)=>{request.signal.addEventListener("abort",()=>reject(request.signal.reason),{once:true});});return "never";}}));ctx.resource({start(){return Bun.write(${JSON.stringify(marker)},"started").then(()=>{});},stop(){return Bun.write(${JSON.stringify(marker)},"stopped").then(()=>{});}});}};`,
    );
    const installing = Bun.spawn(["bun", "install", "--ignore-scripts", "--offline"], {
      cwd: library,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, error] = await Promise.all([
      installing.exited,
      new Response(installing.stderr).text(),
    ]);
    if (code !== 0) throw new Error(error);
    expect(await Bun.file(join(library, "bun.lock")).exists()).toBe(true);
    const imported: unknown = await import(pathToFileURL(join(library, "index.ts")).href);
    expect(await Bun.file(marker).exists()).toBe(false);
    const external = z
      .object({
        default: z.object({
          name: z.string(),
          activate: z.custom<(ctx: Context) => Promise<void> | void>(
            (value) => typeof value === "function",
          ),
        }),
      })
      .parse(imported);
    const runtime = new Runtime({ database: join(host.dir, "inert.db") });
    await runtime.start([external.default]);
    await runtime.stop();
    expect(await Bun.file(marker).text()).toBe("stopped");
    for (const name of ["alpha", "beta"]) {
      const workspace = await host.workspace(name, [
        "@millstrand/spool-batteries",
        "@millstrand/spool-identity",
        "@millstrand/spool-kanban",
        "outside-spool",
        "./deps.ts",
      ]);
      await install(workspace, {
        ...host.packages,
        "outside-spool": `file:${library}`,
        zod: "^4.6.7",
      });
      await mkdir(join(workspace, "node_modules/private-value"), { recursive: true });
      await Bun.write(
        join(workspace, "node_modules/private-value/package.json"),
        '{"name":"private-value","type":"module","exports":"./index.ts"}',
      );
      await Bun.write(
        join(workspace, "node_modules/private-value/index.ts"),
        `export default ${JSON.stringify(name)};`,
      );
      await Bun.write(
        join(workspace, "deps.ts"),
        `import value from "private-value";import {defineOp} from "@millstrand/core";import {z} from "zod";export default {name:"deps",activate(ctx){ctx.register(defineOp({name:"dep",input:z.object({}),output:z.string(),cli:{description:"dependency"},handler:()=>value}));ctx.register(defineOp({name:"relay",input:z.object({value:z.string(),operation:z.string().default("echo")}),output:z.string(),cli:{description:"peer roundtrip"},async handler(input){return await ctx.peers.call("beta",input.operation,{value:input.value});}}));}};`,
      );
      await host.mill(["weaver", "start", "--workspace", workspace]);
      expect(await host.strand(name, "dep", {})).toBe(name);
    }
    expect(await host.mill(["bin", "list", "--workspace", "alpha"])).toEqual({
      operation: "bins list",
      bins: [{ name: "say", description: "External executable" }],
    });
    const unicode = "世界🙂—".repeat(50000);
    const relayed = z.object({ ok: z.literal(true), result: z.string() }).parse(
      JSON.parse(
        await host.wire({
          protocol_version: 1,
          request_id: "unicode-peer",
          operation: "invoke",
          workspace: "alpha",
          payload: { name: "relay", input: { value: unicode } },
        }),
      ),
    );
    expect(relayed.result === unicode).toBe(true);
    expect(
      await host.strand("alpha", "relay", { value: "", operation: "success-stream" }, false),
    ).toContain("Streaming peer calls are unsupported");
    expect(await host.strand("alpha", "issues", {}, false)).toContain("Symbol(field)");
    const streamCli = Bun.spawn([host.strandBin, "--workspace", "alpha", "success-stream"], {
      env: host.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await new Response(streamCli.stdout).text()).toBe("1\n2\n");
    expect(await streamCli.exited).toBe(0);
    const streaming = await host.wire({
      protocol_version: 1,
      request_id: "stream",
      operation: "invoke",
      workspace: "alpha",
      payload: { name: "numbers", input: {} },
    });
    const frames: unknown[] = streaming
      .trim()
      .split("\n")
      .map((line) => z.json().parse(JSON.parse(line)));
    expect(frames.slice(1, 3)).toEqual([1, 2]);
    expect(
      z.object({ done: z.literal(true), success: z.literal(false) }).parse(frames.at(-1)).success,
    ).toBe(false);
    expect(await host.cli(["--workspace", "alpha", "numbers"], false)).toContain("validation");
    expect(await host.cli(["--workspace", "alpha", "--timeout", "1ms", "wait"], false)).toContain(
      "deadline",
    );
    const card = z
      .object({ id: z.string() })
      .parse(await host.strand("beta", "kanban", { command: "add", title: "Downstream" }));
    const mirror = z.object({ id: z.string() }).parse(
      await host.strand("alpha", "kanban", {
        command: "link",
        operation: "attach",
        workspace: "beta",
        id: card.id,
      }),
    );
    expect(
      await host.strand("alpha", "update", { id: mirror.id, title: "forged" }, false),
    ).toContain("requires refresh");
    await host.strand("beta", "kanban", { command: "finish", id: card.id });
    await host.strand("alpha", "kanban", { command: "link", operation: "refresh", id: mirror.id });
    expect(
      z.object({ state: z.string() }).parse(await host.strand("alpha", "show", { id: mirror.id }))
        .state,
    ).toBe("closed");
    expect(await host.cli(["--workspace", "alpha", "help", "kanban", "ref", "add"])).toBeArray();
    const bad = await host.workspace("bad", ["./bad.ts"]);
    const disposed = join(bad, "disposed");
    await Bun.write(
      join(bad, "bad.ts"),
      `export default {name:"bad",activate(ctx){ctx.resource({start(){throw new Error("startup-failure")},stop(){return Bun.write(${JSON.stringify(disposed)},"disposed").then(()=>{});}});}};`,
    );
    expect(await host.mill(["weaver", "start", "--workspace", bad], false)).toContain(
      "startup-failure",
    );
    expect(await Bun.file(disposed).text()).toBe("disposed");
    expect(
      z
        .object({ members: z.array(z.object({ name: z.string() })) })
        .parse(await host.mill(["status"]))
        .members.map((member) => member.name),
    ).not.toContain("bad");
    await host.mill(["weaver", "stop", "--workspace", "beta"]);
    expect(
      z
        .object({ link: z.object({ status: z.string() }) })
        .parse(await host.strand("alpha", "kanban", { command: "card", id: mirror.id })).link
        .status,
    ).toBe("unavailable");
    const healthy = await host.workspace("healthy", ["@millstrand/spool-batteries"]);
    await host.mill(["weaver", "start", "--workspace", healthy]);
    await Bun.write(
      join(host.dir, "alpha/.millstrand/config.json"),
      '{"name":"alpha","spools":["missing-spool"]}',
    );
    expect(await host.mill(["restart-host"], false)).toContain("missing-spool");
    expect(await host.strand("healthy", "list", {})).toEqual([]);
    expect(await host.strand("alpha", "list", {}, false)).toContain("unknown workspace");
  } finally {
    await host.close();
  }
}, 60000);
