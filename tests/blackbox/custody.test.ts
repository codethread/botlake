import { test, expect } from "bun:test";
import { join } from "node:path";

import { z } from "zod";

import { system } from "./fixtures/system.ts";

const fact = z.compile(
  z.object({
    handle: z.string(),
    owner: z.string(),
    key: z.string(),
    phase: z.string(),
    output: z.object({ stdout_ref: z.string(), stderr_ref: z.string() }),
    exit: z.object({ code: z.number() }).optional(),
    cancellation: z
      .object({ stop: z.string(), observed_exit: z.object({ code: z.number() }).optional() })
      .optional(),
    launch_failure: z.object({ message: z.string() }).optional(),
  }),
);
const text = z.compile(z.string());

test("process custody fences owners and keys, retains terminal evidence, and prevents relaunch after acknowledgement", async () => {
  const host = await system();
  try {
    const workspace = await host.workspace("custody", ["./processes.ts"]);
    await Bun.write(
      join(workspace, "processes.ts"),
      `import {defineOp} from "@botlake/core";import {z} from "zod";
const text=z.compile(z.string());const argv=z.compile(z.array(z.string()));
export default {name:"custody",activate(ctx){ctx.register(defineOp({name:"process",input:z.compile(z.object({command:z.enum(["launch","get","list","cancel","ack"]),owner:z.string(),key:z.string(),handle:z.string().optional(),argv:z.array(z.string()).optional()})),output:z.compile(z.json()),cli:{description:"process custody"},async handler(input){
  switch(input.command){
    case "launch":return await ctx.processes.launch({owner:input.owner,key:input.key,command:argv.parse(input.argv)});
    case "list":return await ctx.processes.listOwned(input.owner);
    case "get":return await ctx.processes.get(text.parse(input.handle));
    case "cancel":return await ctx.processes.cancel(text.parse(input.handle),input.owner,input.key);
    case "ack":await ctx.processes.acknowledge(text.parse(input.handle),input.owner,input.key);return null;
  }
}}));}};`,
    );
    await host.botlake(["lake", "start", "--workspace", workspace]);

    const pipe = join(host.dir, "release");
    expect(await Bun.spawn(["mkfifo", pipe]).exited).toBe(0);
    const owner = { owner: "one", key: "task" };
    const launch = {
      ...owner,
      command: "launch",
      argv: ["sh", "-c", 'read line < "$1"; printf "retained output"', "sh", pipe],
    };
    const first = fact.parse(await host.bl("custody", "process", launch));
    expect(fact.parse(await host.bl("custody", "process", launch)).handle).toBe(first.handle);

    expect(
      await host.bl("custody", "process", { ...launch, argv: ["sh", "-c", "exit 1"] }, false),
    ).toContain("different launch spec");
    const selected = { ...owner, handle: first.handle };
    expect(await host.bl("custody", "process", { ...selected, command: "ack" }, false)).toContain(
      "not terminal",
    );
    expect(
      await host.bl("custody", "process", { ...selected, command: "cancel", owner: "two" }, false),
    ).toContain("different owner");
    expect(
      await host.bl("custody", "process", { ...selected, command: "cancel", key: "other" }, false),
    ).toContain("key mismatch");
    expect(
      await host.bl("custody", "process", { ...owner, command: "list", owner: "two" }),
    ).toEqual([]);

    expect(await Bun.spawn(["sh", "-c", 'printf "release\\n" > "$1"', "sh", pipe]).exited).toBe(0);
    let terminal = first;
    for (let attempt = 0; attempt < 100 && terminal.phase !== "terminal"; attempt++)
      terminal = fact.parse(await host.bl("custody", "process", { ...selected, command: "get" }));
    expect(terminal.phase).toBe("terminal");
    expect(terminal.exit?.code).toBe(0);
    expect(terminal.cancellation).toBeUndefined();
    expect(await Bun.file(terminal.output.stdout_ref).text()).toBe("retained output");
    expect(
      await host.bl("custody", "process", { ...selected, command: "ack", owner: "two" }, false),
    ).toContain("different owner");
    expect(
      await host.bl("custody", "process", { ...selected, command: "ack", key: "other" }, false),
    ).toContain("key mismatch");
    expect(await host.bl("custody", "process", { ...selected, command: "ack" })).toBeNull();
    expect(await Bun.file(terminal.output.stdout_ref).exists()).toBe(false);
    expect(await host.bl("custody", "process", { ...owner, command: "list" })).toEqual([]);
    expect(await host.bl("custody", "process", { ...selected, command: "get" }, false)).toContain(
      "unknown custody handle",
    );
    expect(await host.bl("custody", "process", launch, false)).toContain("already acknowledged");

    const missing = fact.parse(
      await host.bl("custody", "process", {
        ...launch,
        key: "missing",
        argv: [join(host.dir, "missing-command")],
      }),
    );
    expect(missing.phase).toBe("terminal");
    expect(missing.launch_failure?.message).toBeString();
    expect(missing.exit).toBeUndefined();

    const cancellable = fact.parse(
      await host.bl("custody", "process", { ...launch, key: "cancel" }),
    );
    const cancel = { ...owner, command: "cancel", key: "cancel", handle: cancellable.handle };
    const cancelled = fact.parse(await host.bl("custody", "process", cancel));
    expect(cancelled.phase).toBe("terminal");
    expect(["graceful", "forced"]).toContain(text.parse(cancelled.cancellation?.stop));
    expect(cancelled.cancellation?.observed_exit?.code).toBeNumber();
    expect(fact.parse(await host.bl("custody", "process", cancel))).toEqual(cancelled);
  } finally {
    await host.close();
  }
}, 60000);
