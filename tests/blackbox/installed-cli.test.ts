import { expect, test } from "bun:test";

import { system } from "./fixtures/system.ts";

test("installed CLIs start and evaluate a lake without a global Core", async () => {
  const host = await system();
  try {
    const workspace = await host.workspace("installed", ["@botlake/extension-batteries"]);
    await host.botlake(["lake", "start", "--workspace", workspace]);
    const child = Bun.spawn(
      [
        host.botlakeBin,
        "lake",
        "eval",
        "--workspace",
        "installed",
        "return await api.call('node', {command:'add',title:'Installed CLI',attributes:{installed:true}});",
      ],
      {
        cwd: host.dir,
        env: { ...host.env, BL_CORE: undefined },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ title: "Installed CLI" });
    expect(await host.cli(["--workspace", "installed", "node", "list"])).toMatchObject({
      total: 1,
    });
  } finally {
    await host.close();
  }
}, 60000);
