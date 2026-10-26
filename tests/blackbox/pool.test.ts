import { test, expect } from "bun:test";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { system } from "./fixtures/system.ts";

test("real Go Mill pools independent workers, routes names, and retains command custody across host recovery", async () => {
  const host = await system();
  try {
    const spool = `import { defineOp } from "@millstrand/core"; import { z } from "zod"; export default { name: "probe", activate(ctx) { ctx.register(defineOp({name:"process", input:z.object({command:z.enum(["launch","list"])}),output:z.json(),cli:{description:"process"},async handler(input){return input.command==="list"?await ctx.processes.listOwned("probe"):await ctx.processes.launch({owner:"probe",key:"one",command:["sh","-c","read x < \\"$1\\"; printf done", "sh",${JSON.stringify(join(host.dir, "release"))}]});}}));ctx.register(defineOp({name:"load",input:z.object({}),output:z.number(),cli:{description:"db load"},handler(){let x=0;for(let i=0;i<10000;i++)x+=ctx.graph.db.query("select 1 as n").get().n;return x;}}));} };`;
    // A FIFO gives the process an explicit release point without timing assumptions.
    const fifo = Bun.spawn(["mkfifo", join(host.dir, "release")]);
    expect(await fifo.exited).toBe(0);
    for (const name of ["alpha", "beta"]) {
      const workspace = await host.workspace(name, ["@millstrand/spool-batteries", "./probe.ts"]);
      await Bun.write(join(workspace, "probe.ts"), spool);
      await host.mill(["weaver", "start", "--workspace", name]);
    }
    await host.cli(["--workspace", "./alpha", "add", "A"]);
    expect(
      z
        .array(z.object({ title: z.string() }))
        .parse(await host.strand("alpha", "list", {}))
        .map((row) => row.title),
    ).toEqual(["A"]);
    expect(await host.strand("beta", "list", {})).toEqual([]);
    const before = z
      .object({ handle: z.string() })
      .parse(await host.strand("alpha", "process", { command: "launch" }));
    await host.mill(["weaver", "restart", "--workspace", "alpha"]);
    expect(
      z
        .array(z.object({ handle: z.string() }))
        .parse(await host.strand("alpha", "process", { command: "list" }))[0]?.handle,
    ).toBe(before.handle);
    await host.mill(["restart-host"]);
    expect(
      z
        .object({ handle: z.string() })
        .parse(await host.strand("alpha", "process", { command: "launch" })).handle,
    ).toBe(before.handle);
    const status = z.object({ hostPid: z.number(), hostReady: z.boolean() });
    const crashed = status.parse(await host.mill(["status"])).hostPid;
    process.kill(crashed, "SIGKILL");
    let recovered = false;
    // Observe the supervisor's actual replacement, without replaying a launch or
    // guessing how long startup takes. Each status call crosses the real socket.
    for (let attempt = 0; attempt < 1000; attempt++) {
      const current = status.parse(await host.mill(["status"]));
      if (current.hostPid !== crashed && current.hostReady) {
        recovered = true;
        break;
      }
    }
    expect(recovered).toBe(true);
    expect(await host.mill(["weaver", "status", "--workspace", "alpha"])).toMatchObject({
      name: "alpha",
      ready: true,
    });
    expect(
      z
        .object({ handle: z.string() })
        .parse(await host.strand("alpha", "process", { command: "launch" })).handle,
    ).toBe(before.handle);
    expect(
      z
        .array(z.object({ handle: z.string() }))
        .parse(await host.strand("alpha", "process", { command: "list" })),
    ).toHaveLength(1);
    expect(
      await Promise.all([host.strand("alpha", "load", {}), host.strand("beta", "list", {})]),
    ).toEqual([10000, []]);
    await host.strand("unknown", "list", {}, false);
    await mkdir(join(host.dir, "duplicate/.millstrand"), { recursive: true });
    await Bun.write(join(host.dir, "duplicate/.millstrand/config.json"), '{"name":"alpha"}');
    await host.mill(["weaver", "start", "--workspace", join(host.dir, "duplicate")], false);
    const release = Bun.spawn(["sh", "-c", 'printf go > "$1"', "sh", join(host.dir, "release")]);
    expect(await release.exited).toBe(0);
  } finally {
    await host.close();
  }
}, 60000);

test("Mill weaver lifecycle publishes validated names and refreshes routes on member and host replacement", async () => {
  const host = await system();
  const spools = ["@millstrand/spool-batteries"];
  try {
    const alpha = await host.workspace("alpha", spools);
    const beta = await host.workspace("beta", spools);
    const healthy = await host.workspace("healthy", spools);
    const configure = (path: string, name?: string): Promise<number> =>
      Bun.write(join(path, ".millstrand/config.json"), JSON.stringify({ name, spools }));
    await configure(alpha);
    expect(await host.mill(["weaver", "start", "--workspace", alpha])).toMatchObject({
      name: "alpha",
    });
    await host.mill(["weaver", "start", "--workspace", beta]);
    await host.mill(["weaver", "start", "--workspace", healthy]);
    expect(await host.mill(["weaver", "list"])).toHaveLength(3);

    // A changed file does not rename a live member until replacement succeeds.
    await configure(alpha, "renamed");
    expect(await host.mill(["weaver", "start", "--workspace", alpha])).toMatchObject({
      name: "alpha",
    });
    await host.mill(["weaver", "restart", "--workspace", alpha]);
    await host.strand("renamed", "add", { title: "A" });
    expect(await host.mill(["weaver", "start", "--workspace", "renamed"])).toMatchObject({
      name: "renamed",
    });

    // Published names win for bare selections; explicit paths still select paths.
    await configure(beta, "alpha");
    await host.mill(["weaver", "restart", "--workspace", beta]);
    expect(await host.strand("alpha", "list", {})).toEqual([]);
    expect(await host.strand("./alpha", "list", {})).toHaveLength(1);
    await configure(alpha, "next");
    await host.mill(["restart-host"]);
    expect(await host.strand("next", "list", {})).toHaveLength(1);
    expect(await host.strand("renamed", "list", {}, false)).toContain("unknown workspace");

    // Reject a colliding member replacement before taking its current worker down.
    await configure(beta, "next");
    expect(await host.mill(["weaver", "restart", "--workspace", beta], false)).toContain(
      "duplicate workspace name",
    );
    expect(await host.strand("alpha", "list", {})).toEqual([]);

    // Pool recovery rejects every ambiguous name, without disrupting healthy peers.
    expect(await host.mill(["restart-host"], false)).toContain("duplicate workspace name");
    expect(await host.mill(["weaver", "list"])).toEqual([
      { path: await realpath(healthy), name: "healthy" },
    ]);
    expect(await host.strand("next", "list", {}, false)).toContain("unknown workspace");
    expect(await host.strand("healthy", "list", {})).toEqual([]);
    await configure(alpha);
    await host.mill(["weaver", "start", "--workspace", alpha]);
    await host.mill(["weaver", "stop", "--workspace", alpha]);
    expect(await host.mill(["weaver", "status", "--workspace", alpha], false)).toContain(
      "unknown workspace",
    );
  } finally {
    await host.close();
  }
}, 60000);
