import { test, expect } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { Runtime, type Context } from "@botlake/core";
import { z } from "zod";

import { system, install } from "./fixtures/system.ts";

const extensionSchema = z.compile(
  z.object({
    default: z.object({
      name: z.string(),
      activate: z.custom<(ctx: Context) => Promise<void> | void>(
        (value) => typeof value === "function",
      ),
    }),
  }),
);
const idResult = z.compile(z.object({ id: z.string() }));
const jsonValue = z.compile(z.json());

test("external Bun package imports stay inert; worker deps, cleanup, wire streams, deadlines and peer links work", async () => {
  const host = await system();
  try {
    const library = join(host.dir, "library");
    await mkdir(library);
    const marker = join(library, "lifecycle");
    await Bun.write(
      join(library, "package.json"),
      JSON.stringify({
        name: "outside-extension",
        type: "module",
        exports: "./index.ts",
        dependencies: {
          ...Object.fromEntries(
            Object.entries(host.packages).filter(([name]) => name === "@botlake/core"),
          ),
          zod: "^4.6.7",
        },
      }),
    );
    await Bun.write(
      join(library, "index.ts"),
      `import {defineOp} from "@botlake/core";import {z} from "zod";
export const op=defineOp({name:"echo",input:z.compile(z.object({value:z.string()})),output:z.compile(z.string()),cli:{description:"echo",positionals:[{name:"value",type:"string",required:true}]},handler:input=>input.value});
export default {name:"outside",activate(ctx){ctx.register(op);ctx.register(defineOp({name:"issues",input:{"~standard":{version:1,vendor:"fixture",validate:()=>({issues:[{message:"invalid",path:[Symbol("field")]}]})}},output:z.compile(z.string()),cli:{description:"issues"},handler:()=>"never"}));ctx.register(defineOp({name:"success-stream",input:z.compile(z.object({})),output:z.compile(z.number()),stream:true,cli:{description:"stream"},async *handler(){yield 1;yield 2;}}));ctx.bin("say",{description:"External executable",exec:{command:"echo"}});ctx.register(defineOp({name:"numbers",input:z.compile(z.object({})),output:z.compile(z.number().positive()),stream:true,cli:{description:"numbers"},async *handler(){yield 1;yield 2;yield 0;}}));ctx.register(defineOp({name:"wait",input:z.compile(z.object({})),output:z.compile(z.string()),cli:{description:"wait"},async handler(_,ctx,request){await new Promise((resolve,reject)=>{request.signal.addEventListener("abort",()=>reject(request.signal.reason),{once:true});});return "never";}}));ctx.resource({start(){return Bun.write(${JSON.stringify(marker)},"started").then(()=>{});},stop(){return Bun.write(${JSON.stringify(marker)},"stopped").then(()=>{});}});}};`,
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
    const external = extensionSchema.parse(imported);
    const runtime = new Runtime({ database: join(host.dir, "inert.db") });
    await runtime.start([external.default]);
    await runtime.stop();
    expect(await Bun.file(marker).text()).toBe("stopped");
    for (const name of ["alpha", "beta"]) {
      const workspace = await host.workspace(name, [
        "@botlake/extension-batteries",
        "@botlake/extension-identity",
        "@botlake/extension-kanban",
        "outside-extension",
        "./deps.ts",
      ]);
      await install(workspace, {
        ...host.packages,
        "outside-extension": `file:${library}`,
        zod: "^4.6.7",
      });
      await mkdir(join(workspace, "node_modules/private-value"), { recursive: true });
      await Bun.write(
        join(workspace, "node_modules/private-value/package.json"),
        '{"name":"private-value","type":"module","exports":"./index.ts"}',
      );
      await Bun.write(
        join(workspace, "node_modules/private-value/index.ts"),
        `export const value = ${JSON.stringify(name)};`,
      );
      await Bun.write(
        join(workspace, "deps.ts"),
        `import {value} from "private-value";import {defineOp} from "@botlake/core";import {z} from "zod";export default {name:"deps",activate(ctx){ctx.register(defineOp({name:"dep",input:z.compile(z.object({})),output:z.compile(z.string()),cli:{description:"dependency"},handler:()=>value}));ctx.register(defineOp({name:"relay",input:z.compile(z.object({value:z.string(),operation:z.string().default("echo")})),output:z.compile(z.string()),cli:{description:"peer roundtrip"},async handler(input){return await ctx.peers.call("beta",input.operation,{value:input.value});}}));}};`,
      );
      await host.botlake(["lake", "start", "--workspace", workspace]);
      expect(await host.bl(name, "dep", {})).toBe(name);
    }
    expect(await host.botlake(["bin", "list", "--workspace", "alpha"])).toEqual({
      operation: "bins list",
      bins: [{ name: "say", description: "External executable" }],
    });
    const unicode = "世界🙂—".repeat(50000);
    const relayed = z.compile(z.object({ ok: z.literal(true), result: z.string() })).parse(
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
      await host.bl("alpha", "relay", { value: "", operation: "success-stream" }, false),
    ).toContain("Streaming peer calls are unsupported");
    expect(await host.bl("alpha", "issues", {}, false)).toContain("Symbol(field)");
    const streamCli = Bun.spawn([host.blBin, "--workspace", "alpha", "success-stream"], {
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
      .map((line) => jsonValue.parse(JSON.parse(line)));
    expect(frames.slice(1, 3)).toEqual([1, 2]);
    expect(
      z.compile(z.object({ done: z.literal(true), success: z.literal(false) })).parse(frames.at(-1))
        .success,
    ).toBe(false);
    expect(await host.cli(["--workspace", "alpha", "numbers"], false)).toContain("validation");
    expect(await host.cli(["--workspace", "alpha", "--timeout", "1ms", "wait"], false)).toContain(
      "deadline",
    );
    const card = idResult.parse(
      await host.bl("beta", "kanban", { command: "add", title: "Downstream" }),
    );
    const mirror = idResult.parse(
      await host.bl("alpha", "kanban", {
        command: "link",
        operation: "attach",
        workspace: "beta",
        id: card.id,
      }),
    );
    expect(await host.bl("alpha", "update", { id: mirror.id, title: "forged" }, false)).toContain(
      "requires refresh",
    );
    await host.bl("beta", "kanban", { command: "finish", id: card.id });
    await host.bl("alpha", "kanban", { command: "link", operation: "refresh", id: mirror.id });
    expect(
      z
        .compile(z.object({ state: z.string() }))
        .parse(await host.bl("alpha", "show", { id: mirror.id })).state,
    ).toBe("closed");
    expect(await host.cli(["--workspace", "alpha", "help", "kanban", "ref", "add"])).toBeArray();
    const bad = await host.workspace("bad", ["./bad.ts"]);
    const disposed = join(bad, "disposed");
    await Bun.write(
      join(bad, "bad.ts"),
      `export default {name:"bad",activate(ctx){ctx.resource({start(){throw new Error("startup-failure")},stop(){return Bun.write(${JSON.stringify(disposed)},"disposed").then(()=>{});}});}};`,
    );
    expect(await host.botlake(["lake", "start", "--workspace", bad], false)).toContain(
      "startup-failure",
    );
    expect(await Bun.file(disposed).text()).toBe("disposed");
    expect(
      z
        .compile(z.object({ members: z.array(z.object({ name: z.string() })) }))
        .parse(await host.botlake(["status"]))
        .members.map((member) => member.name),
    ).not.toContain("bad");
    await host.botlake(["lake", "stop", "--workspace", "beta"]);
    expect(
      z
        .compile(z.object({ link: z.object({ status: z.string() }) }))
        .parse(await host.bl("alpha", "kanban", { command: "card", id: mirror.id })).link.status,
    ).toBe("unavailable");
    const healthy = await host.workspace("healthy", ["@botlake/extension-batteries"]);
    await host.botlake(["lake", "start", "--workspace", healthy]);
    await Bun.write(
      join(host.dir, "alpha/.botlake/package.json"),
      '{"botlake":{"name":"alpha","extensions":["missing-extension"]}}',
    );
    expect(await host.botlake(["restart-host"], false)).toContain("missing-extension");
    expect(await host.bl("healthy", "list", {})).toEqual([]);
    expect(await host.bl("alpha", "list", {}, false)).toContain("unknown workspace");
  } finally {
    await host.close();
  }
}, 60000);
