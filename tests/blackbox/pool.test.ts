import { test, expect } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { z } from "zod";

const root = resolve(import.meta.dir, "../..");
test("real Go Mill pools independent workers, routes names, and retains command custody across host recovery", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mill-pool-"));
  const home = join(dir, "mill");
  const mill = join(dir, "mill-bin");
  const strand = join(dir, "strand-bin");
  const env = { ...process.env, MILL_HOME: home, MILLSTRAND_SOURCE: root };
  for (const [name, output] of [
    ["mill", mill],
    ["strand", strand],
  ]) {
    const build = Bun.spawn(["go", "build", "-o", output ?? "", `./cmd/${name ?? ""}`], {
      cwd: join(root, "cli"),
      env: { ...process.env, GOPROXY: "off" },
      stderr: "pipe",
    });
    if ((await build.exited) !== 0) throw new Error(await new Response(build.stderr).text());
  }
  const api = join(root, "src/index.ts");
  const spool = `import { defineOp } from ${JSON.stringify(api)}; import { z } from ${JSON.stringify(join(root, "node_modules/zod/index.js"))}; export default { name: "probe", activate(ctx) { ctx.register(defineOp({name:"process", input:z.object({command:z.enum(["launch","list"])}),output:z.json(),cli:{description:"process"},async handler(input){return input.command==="list"?await ctx.processes.listOwned("probe"):await ctx.processes.launch({owner:"probe",key:"one",command:["sh","-c","read x < \\"$1\\"; printf done", "sh",${JSON.stringify(join(dir, "release"))}]});}}));ctx.register(defineOp({name:"load",input:z.object({}),output:z.number(),cli:{description:"db load"},handler(){let x=0;for(let i=0;i<10000;i++)x+=ctx.graph.db.query("select 1 as n").get().n;return x;}}));ctx.bin("probe","process");} };`;
  // A FIFO gives the process an explicit release point without timing assumptions.
  const fifo = Bun.spawn(["mkfifo", join(dir, "release")]);
  expect(await fifo.exited).toBe(0);
  for (const name of ["alpha", "beta"]) {
    await mkdir(join(dir, name, ".millstrand"), { recursive: true });
    await Bun.write(join(dir, name, "probe.ts"), spool);
    await Bun.write(
      join(dir, name, ".millstrand/config.json"),
      JSON.stringify({ name, spools: ["batteries", "./probe.ts"] }),
    );
  }
  const daemon = Bun.spawn([mill, "serve"], { env, stdout: "pipe", stderr: "pipe" });
  async function run(binary: string, args: string[], ok = true): Promise<unknown> {
    const child = Bun.spawn([binary, ...args], { env, cwd: dir, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (ok && code !== 0)
      throw new Error(
        `${args.join(" ")}: ${stderr}\n${await Bun.file(join(home, "host.log")).text()}`,
      );
    if (!ok) {
      expect(code).not.toBe(0);
      return stderr;
    }
    return JSON.parse(stdout);
  }
  try {
    const reader = daemon.stdout.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('"ready":true');
    reader.releaseLock();
    for (const name of ["alpha", "beta"]) await run(mill, ["up", name]);
    await run(strand, ["--workspace", "./alpha", "add", "A"]);
    expect(
      z
        .array(z.object({ title: z.string() }))
        .parse(await run(strand, ["--workspace", "alpha", "list"]))
        .map((row) => row.title),
    ).toEqual(["A"]);
    expect(await run(strand, ["--workspace", "beta", "list"])).toEqual([]);
    const before = z
      .object({ handle: z.string() })
      .parse(
        await run(strand, ["--workspace", "alpha", "process", "--payload", '{"command":"launch"}']),
      );
    await run(mill, ["restart", "alpha"]);
    expect(
      z
        .array(z.object({ handle: z.string() }))
        .parse(
          await run(strand, ["--workspace", "alpha", "process", "--payload", '{"command":"list"}']),
        )[0]?.handle,
    ).toBe(before.handle);
    await run(mill, ["restart-host"]);
    expect(
      z
        .object({ handle: z.string() })
        .parse(
          await run(strand, [
            "--workspace",
            "alpha",
            "process",
            "--payload",
            '{"command":"launch"}',
          ]),
        ).handle,
    ).toBe(before.handle);
    expect(
      await Promise.all([
        run(strand, ["--workspace", "alpha", "load"]),
        run(strand, ["--workspace", "beta", "list"]),
      ]),
    ).toEqual([10000, []]);
    await run(strand, ["--workspace", "unknown", "list"], false);
    await mkdir(join(dir, "duplicate", ".millstrand"), { recursive: true });
    await Bun.write(join(dir, "duplicate", ".millstrand/config.json"), '{"name":"alpha"}');
    await run(mill, ["up", join(dir, "duplicate")], false);
    const release = Bun.spawn(["sh", "-c", 'printf go > "$1"', "sh", join(dir, "release")]);
    expect(await release.exited).toBe(0);
  } finally {
    await run(mill, ["stop"]);
    expect(await daemon.exited).toBe(0);
    await rm(dir, { recursive: true, force: true });
  }
}, 60000);
