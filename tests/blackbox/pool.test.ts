import { test, expect } from "bun:test";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { system } from "./fixtures/system.ts";

const titles = z.compile(z.array(z.object({ title: z.string() })));
const handleRow = z.compile(z.object({ handle: z.string() }));
const handleRows = z.compile(z.array(z.object({ handle: z.string() })));
const hostStatus = z.compile(z.object({ hostPid: z.number(), hostReady: z.boolean() }));

test("real Go Botlake pools independent workers, routes names, and retains command custody across host recovery", async () => {
  const host = await system();
  try {
    const extension = `import { defineOp } from "@botlake/core"; import { z } from "zod"; export default { name: "probe", activate(ctx) { ctx.register(defineOp({name:"process", input:z.compile(z.object({command:z.enum(["launch","list"])})),output:z.compile(z.json()),cli:{description:"process"},async handler(input){return input.command==="list"?await ctx.processes.listOwned("probe"):await ctx.processes.launch({owner:"probe",key:"one",command:["sh","-c","read x < \\"$1\\"; printf done", "sh",${JSON.stringify(join(host.dir, "release"))}]});}}));ctx.register(defineOp({name:"load",input:z.compile(z.object({})),output:z.compile(z.number()),cli:{description:"db load"},handler(){let x=0;for(let i=0;i<10000;i++)x+=ctx.graph.db.query("select 1 as n").get().n;return x;}}));} };`;
    // A FIFO gives the process an explicit release point without timing assumptions.
    const fifo = Bun.spawn(["mkfifo", join(host.dir, "release")]);
    expect(await fifo.exited).toBe(0);
    for (const name of ["alpha", "beta"]) {
      const workspace = await host.workspace(name, ["@botlake/extension-batteries", "./probe.ts"]);
      await Bun.write(join(workspace, "probe.ts"), extension);
      await host.botlake(["lake", "start", "--workspace", name]);
    }
    await host.cli(["--workspace", "./alpha", "add", "A"]);
    expect(titles.parse(await host.bl("alpha", "list", {})).map((row) => row.title)).toEqual(["A"]);
    expect(await host.bl("beta", "list", {})).toEqual([]);
    const before = handleRow.parse(await host.bl("alpha", "process", { command: "launch" }));
    await host.botlake(["lake", "restart", "--workspace", "alpha"]);
    expect(
      handleRows.parse(await host.bl("alpha", "process", { command: "list" }))[0]?.handle,
    ).toBe(before.handle);
    await host.botlake(["restart-host"]);
    expect(handleRow.parse(await host.bl("alpha", "process", { command: "launch" })).handle).toBe(
      before.handle,
    );
    const crashed = hostStatus.parse(await host.botlake(["status"])).hostPid;
    process.kill(crashed, "SIGKILL");
    let recovered = false;
    // Observe the supervisor's actual replacement, without replaying a launch or
    // guessing how long startup takes. Each status call crosses the real socket.
    for (let attempt = 0; attempt < 1000; attempt++) {
      const current = hostStatus.parse(await host.botlake(["status"]));
      if (current.hostPid !== crashed && current.hostReady) {
        recovered = true;
        break;
      }
    }
    expect(recovered).toBe(true);
    expect(await host.botlake(["lake", "status", "--workspace", "alpha"])).toMatchObject({
      name: "alpha",
      ready: true,
    });
    expect(handleRow.parse(await host.bl("alpha", "process", { command: "launch" })).handle).toBe(
      before.handle,
    );
    expect(handleRows.parse(await host.bl("alpha", "process", { command: "list" }))).toHaveLength(
      1,
    );
    expect(await Promise.all([host.bl("alpha", "load", {}), host.bl("beta", "list", {})])).toEqual([
      10000,
      [],
    ]);
    await host.bl("unknown", "list", {}, false);
    await mkdir(join(host.dir, "duplicate/.botlake"), { recursive: true });
    await Bun.write(
      join(host.dir, "duplicate/.botlake/package.json"),
      '{"botlake":{"name":"alpha"}}',
    );
    await host.botlake(["lake", "start", "--workspace", join(host.dir, "duplicate")], false);
    const release = Bun.spawn(["sh", "-c", 'printf go > "$1"', "sh", join(host.dir, "release")]);
    expect(await release.exited).toBe(0);
  } finally {
    await host.close();
  }
}, 60000);

test("Botlake lake lifecycle publishes validated names and refreshes routes on member and host replacement", async () => {
  const host = await system();
  const extensions = ["@botlake/extension-batteries"];
  try {
    const alpha = await host.workspace("alpha", extensions);
    const beta = await host.workspace("beta", extensions);
    const healthy = await host.workspace("healthy", extensions);
    const configure = (path: string, name?: string): Promise<number> =>
      Bun.write(
        join(path, ".botlake/package.json"),
        JSON.stringify({ botlake: { name, extensions } }),
      );
    await configure(alpha);
    expect(await host.botlake(["lake", "start", "--workspace", alpha])).toMatchObject({
      name: "alpha",
    });
    await host.botlake(["lake", "start", "--workspace", beta]);
    await host.botlake(["lake", "start", "--workspace", healthy]);
    expect(await host.botlake(["lake", "list"])).toHaveLength(3);

    // A changed file does not rename a live member until replacement succeeds.
    await configure(alpha, "renamed");
    expect(await host.botlake(["lake", "start", "--workspace", alpha])).toMatchObject({
      name: "alpha",
    });
    await host.botlake(["lake", "restart", "--workspace", alpha]);
    await host.bl("renamed", "add", { title: "A" });
    expect(await host.botlake(["lake", "start", "--workspace", "renamed"])).toMatchObject({
      name: "renamed",
    });

    // Published names win for bare selections; explicit paths still select paths.
    await configure(beta, "alpha");
    await host.botlake(["lake", "restart", "--workspace", beta]);
    expect(await host.bl("alpha", "list", {})).toEqual([]);
    expect(await host.bl("./alpha", "list", {})).toHaveLength(1);
    await configure(alpha, "next");
    await host.botlake(["restart-host"]);
    expect(await host.bl("next", "list", {})).toHaveLength(1);
    expect(await host.bl("renamed", "list", {}, false)).toContain("unknown workspace");

    // Reject a colliding member replacement before taking its current worker down.
    await configure(beta, "next");
    expect(await host.botlake(["lake", "restart", "--workspace", beta], false)).toContain(
      "duplicate workspace name",
    );
    expect(await host.bl("alpha", "list", {})).toEqual([]);

    // Pool recovery rejects every ambiguous name, without disrupting healthy peers.
    expect(await host.botlake(["restart-host"], false)).toContain("duplicate workspace name");
    expect(await host.botlake(["lake", "list"])).toEqual([
      { path: await realpath(healthy), name: "healthy" },
    ]);
    expect(await host.bl("next", "list", {}, false)).toContain("unknown workspace");
    expect(await host.bl("healthy", "list", {})).toEqual([]);
    await configure(alpha);
    await host.botlake(["lake", "start", "--workspace", alpha]);
    await host.botlake(["lake", "stop", "--workspace", alpha]);
    expect(await host.botlake(["lake", "status", "--workspace", alpha], false)).toContain(
      "unknown workspace",
    );
  } finally {
    await host.close();
  }
}, 60000);
