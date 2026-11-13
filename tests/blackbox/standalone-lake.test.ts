import { expect, test } from "bun:test";
import { mkdir, realpath, rm, symlink } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { system } from "./fixtures/system.ts";

async function run(
  binary: string,
  args: string[],
  env: Record<string, string | undefined>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([binary, ...args], { env, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

test("standalone lake publishes only after readiness and reports packed provenance", async () => {
  const host = await system();
  try {
    const workspace = await host.workspace("standalone", ["@botlake/extension-batteries"]);
    const started = await host.botlake(["lake", "start", "--workspace", workspace]);
    expect(started).toMatchObject({ name: "standalone" });
    const status = z
      .object({ pid: z.number() })
      .parse(await host.botlake(["lake", "status", "--workspace", workspace]));
    expect(status.pid).toBeGreaterThan(0);
    expect(status.pid).not.toBe(process.pid);
    expect(
      await host.bl("standalone", "node", { command: "add", title: "Owned by Bun" }),
    ).toMatchObject({
      title: "Owned by Bun",
    });
    expect(await host.bl("standalone", "node", { command: "list" })).toMatchObject({ total: 1 });
    const info = z
      .object({
        extensions: z.array(
          z.object({ name: z.string(), source: z.string(), packageJson: z.string() }),
        ),
      })
      .loose()
      .parse(await host.botlake(["lake", "info", "--workspace", "standalone"]));
    expect(info).toMatchObject({
      path: await realpath(workspace),
      name: "standalone",
      configPath: join(await realpath(workspace), ".botlake/lake.ts"),
      packageJson: join(await realpath(workspace), ".botlake/package.json"),
    });
    expect(info.extensions).toHaveLength(1);
    const extension = info.extensions[0];
    if (extension === undefined) throw new Error("Expected Batteries provenance");
    expect(extension.name).toBe("batteries");
    expect(extension.source).toContain("@botlake/extension-batteries/src/index.ts");
    expect(extension.packageJson).toContain("@botlake/extension-batteries/package.json");
  } finally {
    await host.close();
  }
}, 60000);

test("standalone unary calls survive silence and preserve typed restart outcomes", async () => {
  const host = await system();
  try {
    const workspace = await host.workspace("restart-unary", ["./slow.ts"]);
    const marker = join(host.dir, "slow-started");
    await Bun.write(
      join(workspace, "slow.ts"),
      `import {defineOp} from "@botlake/core";
import {z} from "zod";
export default {name:"slow",activate(ctx){ctx.register(defineOp({name:"slow",input:z.compile(z.object({ms:z.number(),value:z.string()})),output:z.compile(z.string()),cli:{description:"slow unary"},async handler(input){await Bun.write(${JSON.stringify(marker)},input.value);await Bun.sleep(input.ms);return input.value;}}));}};`,
    );
    const sibling = await host.workspace("restart-sibling", ["@botlake/extension-batteries"]);
    await host.botlake(["lake", "start", "--workspace", workspace]);
    await host.botlake(["lake", "start", "--workspace", sibling]);
    const initial = z
      .object({ pid: z.number() })
      .parse(await host.botlake(["lake", "status", "--workspace", workspace]));

    const completed = host.bl("restart-unary", "slow", { ms: 100, value: "completed" });
    while (!(await Bun.file(marker).exists())) await Bun.sleep(10);
    const firstRestart = host.botlake(["lake", "restart", "--workspace", workspace]);
    expect(await completed).toBe("completed");
    await firstRestart;

    await rm(marker, { force: true });
    const interrupted = host.cli(
      [
        "--json",
        "--workspace",
        "restart-unary",
        "--input",
        JSON.stringify({ ms: 10_000, value: "interrupted" }),
        "slow",
      ],
      false,
    );
    while (!(await Bun.file(marker).exists())) await Bun.sleep(10);
    const restart = host.botlake(["lake", "restart", "--workspace", workspace]);
    await Bun.sleep(50);
    expect(await host.bl("restart-sibling", "node", { command: "list" })).toMatchObject({
      total: 0,
    });
    const rejected = String(
      await host.cli(
        [
          "--json",
          "--workspace",
          "restart-unary",
          "--input",
          JSON.stringify({ ms: 0, value: "new" }),
          "slow",
        ],
        false,
      ),
    );
    expect(JSON.parse(rejected)).toMatchObject({
      code: "lake-restarting",
      details: { delivery: "not-admitted", workspace: await realpath(workspace) },
    });
    expect(JSON.parse(String(await interrupted))).toMatchObject({
      code: "lake-restarting",
      details: { delivery: "uncertain", workspace: await realpath(workspace) },
    });
    await restart;
    const replacement = z
      .object({ pid: z.number() })
      .parse(await host.botlake(["lake", "status", "--workspace", workspace]));
    expect(replacement.pid).not.toBe(initial.pid);
    expect(await host.bl("restart-unary", "slow", { ms: 0, value: "replacement" })).toBe(
      "replacement",
    );
    // Domain deadlines, not HTTP inactivity, govern a handler awaiting its result.
    expect(await host.bl("restart-unary", "slow", { ms: 15_000, value: "quiet result" })).toBe(
      "quiet result",
    );
  } finally {
    await host.close();
  }
}, 60000);

test("real bl streams items and reports a typed terminal when restart interrupts it", async () => {
  const host = await system();
  try {
    const workspace = await host.workspace("restart-stream", ["./stream.ts"]);
    await Bun.write(
      join(workspace, "stream.ts"),
      `import {defineOp} from "@botlake/core";
import {z} from "zod";
export default {name:"stream",activate(ctx){ctx.register(defineOp({name:"numbers",stream:true,input:z.compile(z.object({count:z.number(),delay:z.number()})),output:z.compile(z.number()),cli:{description:"stream numbers"},async *handler(input){for(let value=0;value<input.count;value++){yield value;await Bun.sleep(input.delay);}}}));}};`,
    );
    await host.botlake(["lake", "start", "--workspace", workspace]);

    const finite = await run(
      host.blBin,
      ["--workspace", "restart-stream", "--input", '{"count":3,"delay":1}', "numbers"],
      host.env,
    );
    expect(finite).toEqual({ code: 0, stdout: "0\n1\n2\n", stderr: "" });

    const interrupted = run(
      host.blBin,
      [
        "--json",
        "--workspace",
        "restart-stream",
        "--input",
        '{"count":100,"delay":100}',
        "numbers",
      ],
      host.env,
    );
    await Bun.sleep(250);
    await host.botlake(["lake", "restart", "--workspace", workspace]);
    const result = await interrupted;
    expect(result.code).not.toBe(0);
    expect(result.stdout).toStartWith("0\n1\n");
    expect(JSON.parse(result.stderr)).toMatchObject({
      code: "lake-restarting",
      details: { delivery: "uncertain", workspace: await realpath(workspace) },
    });
  } finally {
    await host.close();
  }
}, 60000);

test("process custody survives restart failure and is cleaned up by orderly supervisor shutdown", async () => {
  const host = await system();
  try {
    const workspace = await host.workspace("custody-restart", ["./custody.ts"]);
    const gracefulPid = join(host.dir, "graceful.pid");
    const forcedPid = join(host.dir, "forced.pid");
    const launches = join(host.dir, "launches");
    await Bun.write(
      join(workspace, "custody.ts"),
      `import {defineOp} from "@botlake/core";
import {z} from "zod";
const gracefulPid=${JSON.stringify(gracefulPid)};
const forcedPid=${JSON.stringify(forcedPid)};
const launches=${JSON.stringify(launches)};
export default {name:"custody",async activate(ctx){
const graceful=await ctx.processes.launch({owner:"custody-fixture",key:"graceful",command:["sh","-c",\`echo $$ > \${JSON.stringify(gracefulPid)}; echo graceful >> \${JSON.stringify(launches)}; exec sleep 1000\`]});
const forced=await ctx.processes.launch({owner:"custody-fixture",key:"forced",command:["sh","-c",\`echo $$ > \${JSON.stringify(forcedPid)}; echo forced >> \${JSON.stringify(launches)}; trap '' TERM; while :; do :; done\`]});
while(!(await Bun.file(gracefulPid).exists())||!(await Bun.file(forcedPid).exists()))await Bun.sleep(10);
ctx.register(defineOp({name:"custody-status",input:z.compile(z.object({})),output:z.compile(z.object({handle:z.string(),pid:z.number(),launches:z.number(),phases:z.array(z.string())})),cli:{description:"custody status"},async handler(){return {handle:graceful.handle,pid:Number((await Bun.file(gracefulPid).text()).trim()),launches:(await Bun.file(launches).text()).trim().split("\\n").length,phases:[(await ctx.processes.get(graceful.handle)).phase,(await ctx.processes.get(forced.handle)).phase]};}}));
}};`,
    );
    const configPath = join(workspace, ".botlake/lake.ts");
    const config = await Bun.file(configPath).text();
    await host.botlake(["lake", "start", "--workspace", workspace]);
    const statusSchema = z.object({
      handle: z.string(),
      pid: z.number(),
      launches: z.number(),
      phases: z.array(z.string()),
    });
    const initial = statusSchema.parse(await host.bl("custody-restart", "custody-status", {}));
    expect(initial.launches).toBe(2);
    expect(initial.phases).toEqual(["running", "running"]);

    await Bun.write(configPath, 'throw new Error("replacement-broken");');
    expect(await host.botlake(["lake", "restart", "--workspace", workspace], false)).toContain(
      "replacement-broken",
    );
    expect(() => process.kill(initial.pid, 0)).not.toThrow();

    await Bun.write(configPath, config);
    await host.botlake(["lake", "start", "--workspace", workspace]);
    const adopted = statusSchema.parse(await host.bl("custody-restart", "custody-status", {}));
    expect(adopted).toEqual(initial);

    const forcedProcessPid = Number((await Bun.file(forcedPid).text()).trim());
    const shutdownStarted = performance.now();
    await host.stopSupervisor();
    while (performance.now() - shutdownStarted < 10_000) {
      try {
        process.kill(forcedProcessPid, 0);
        await Bun.sleep(25);
      } catch {
        break;
      }
    }
    expect(performance.now() - shutdownStarted).toBeGreaterThanOrEqual(1900);
    expect(() => process.kill(initial.pid, 0)).toThrow();
    expect(() => process.kill(forcedProcessPid, 0)).toThrow();
  } finally {
    await host.close();
  }
}, 60000);

test("incompatible runner wire versions fail before publication and release the lease", async () => {
  const host = await system();
  try {
    const workspace = await host.workspace("wire-version", ["./activation.ts"]);
    const marker = join(host.dir, "activated");
    await Bun.write(
      join(workspace, "activation.ts"),
      `export default {name:"activation",async activate(){await Bun.write(${JSON.stringify(marker)},"activated");}};`,
    );
    const version = join(workspace, "node_modules/@botlake/core/src/runtime/version.ts");
    const source = await Bun.file(version).text();
    expect(source).toContain("export const lakeWireVersion = 1;");
    await Bun.write(
      version,
      source.replace("export const lakeWireVersion = 1;", "export const lakeWireVersion = 2;"),
    );
    expect(await host.botlake(["lake", "start", "--workspace", workspace], false)).toContain(
      "incompatible lake wire protocol: supervisor lakeWireVersion=1, lake lakeWireVersion=2",
    );
    expect(await host.botlake(["lake", "list"])).toEqual([]);
    expect(await Bun.file(marker).exists()).toBe(false);
    expect(await Bun.file(join(workspace, ".botlake/world.db")).exists()).toBe(false);
    await Bun.write(version, source);
    expect(await host.botlake(["lake", "start", "--workspace", workspace])).toMatchObject({
      name: "wire-version",
    });
    expect(await Bun.file(marker).exists()).toBe(true);
  } finally {
    await host.close();
  }
}, 60000);

test("an overdue resource stop is force killed and releases its lease", async () => {
  const host = await system();
  const secondHome = join(host.dir, "forced-second-home");
  let second: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const workspace = await host.workspace("forced-stop", ["./stuck.ts"]);
    await Bun.write(
      join(workspace, "stuck.ts"),
      `export default {name:"stuck",activate(ctx){ctx.resource({start(){},stop(){return new Promise(()=>{});}});}};`,
    );
    await host.botlake(["lake", "start", "--workspace", workspace]);
    const status = z
      .object({ pid: z.number() })
      .parse(await host.botlake(["lake", "status", "--workspace", workspace]));
    expect(await host.botlake(["lake", "stop", "--workspace", workspace], false)).toContain(
      "shutdown timed out",
    );
    expect(() => process.kill(status.pid, 0)).toThrow();

    await mkdir(secondHome);
    const secondEnv = { ...host.env, BL_HOME: secondHome };
    const daemon = Bun.spawn([host.botlakeBin, "start"], {
      env: secondEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    second = daemon;
    const reader = daemon.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('"ready":true');
    reader.releaseLock();
    expect(
      (await run(host.botlakeBin, ["lake", "start", "--workspace", workspace], secondEnv)).code,
    ).toBe(0);
    expect((await run(host.botlakeBin, ["stop"], secondEnv)).code).toBe(0);
    await second.exited;
    second = undefined;
  } finally {
    second?.kill("SIGKILL");
    await host.close();
    await rm(secondHome, { recursive: true, force: true });
  }
}, 60000);

test("the runtime lease descriptor is not inherited by an unrelated child", async () => {
  const host = await system();
  try {
    const workspace = await host.workspace("lease-child", ["./descriptor.ts"]);
    await Bun.write(
      join(workspace, "descriptor.ts"),
      `import {defineOp} from "@botlake/core";
import {z} from "zod";
export default {name:"descriptor",activate(ctx){ctx.register(defineOp({name:"lease-fd",input:z.compile(z.object({})),output:z.compile(z.string()),cli:{description:"lease fd"},async handler(){const child=Bun.spawn(["sh","-c","test -e /dev/fd/4 && printf inherited || printf closed"],{stdout:"pipe",stderr:"pipe"});const output=await new Response(child.stdout).text();await child.exited;return output;}}));}};`,
    );
    await host.botlake(["lake", "start", "--workspace", workspace]);
    expect(await host.bl("lease-child", "lease-fd", {})).toBe("closed");
  } finally {
    await host.close();
  }
}, 60000);

test("failed and competing starts do not publish or retain the database lease", async () => {
  const host = await system();
  const secondHome = join(host.dir, "second-home");
  let second: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const first = await host.workspace("first", []);
    const { version: coreVersion } = z
      .object({ version: z.string() })
      .parse(await Bun.file(join(first, "node_modules/@botlake/core/package.json")).json());
    const duplicate = await host.workspace("duplicate", []);
    await Bun.write(
      join(duplicate, ".botlake/lake.ts"),
      'import {createLake} from "@botlake/core"; export const lake=createLake({name:"first",extensions:[]});',
    );
    await host.botlake(["lake", "start", "--workspace", first]);
    expect(await host.botlake(["lake", "start", "--workspace", duplicate], false)).toContain(
      "duplicate workspace name",
    );

    const broken = await host.workspace("broken", []);
    await Bun.write(join(broken, ".botlake/lake.ts"), 'throw new Error("bad-config");');
    expect(await host.botlake(["lake", "start", "--workspace", broken], false)).toContain(
      "bad-config",
    );
    expect(await host.botlake(["lake", "list"])).toEqual([
      { path: await realpath(first), name: "first", coreVersion, lakeWireVersion: 1 },
    ]);

    await mkdir(secondHome);
    const secondEnv = { ...host.env, BL_HOME: secondHome };
    const daemon = Bun.spawn([host.botlakeBin, "start"], {
      env: secondEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    second = daemon;
    const reader = daemon.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('"ready":true');
    reader.releaseLock();
    const alias = join(host.dir, "first-alias");
    await symlink(first, alias);
    const rejected = await run(host.botlakeBin, ["lake", "start", "--workspace", alias], secondEnv);
    expect(rejected.code).not.toBe(0);
    expect(rejected.stderr).toContain("already owned by another supervisor");

    await host.botlake(["lake", "stop", "--workspace", first]);
    expect(
      (await run(host.botlakeBin, ["lake", "start", "--workspace", alias], secondEnv)).code,
    ).toBe(0);
    expect(
      (await run(host.botlakeBin, ["lake", "stop", "--workspace", alias], secondEnv)).code,
    ).toBe(0);
    expect((await run(host.botlakeBin, ["stop"], secondEnv)).code).toBe(0);
    await second.exited;
    second = undefined;
  } finally {
    second?.kill("SIGKILL");
    await host.close();
    await rm(secondHome, { recursive: true, force: true });
  }
}, 60000);
