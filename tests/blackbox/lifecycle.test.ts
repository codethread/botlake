import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ManualClock, Runtime } from "@botlake/core";
import { z } from "zod";

import { system } from "./fixtures/system.ts";

const lakes = z.compile(z.array(z.object({ name: z.string() })));
const status = z.compile(z.object({ hostPid: z.number() }));
const frame = z.compile(z.object({ ok: z.boolean() }));

test("workers publish readiness after registration and report cleanup failures while preserving sibling workspaces", async () => {
  const host = await system();
  try {
    const healthy = await host.workspace("healthy", ["@botlake/extension-batteries"]);
    await host.botlake(["lake", "start", "--workspace", healthy]);

    const late = await host.workspace("late", ["./extension.ts"]);
    const disposed = join(late, "disposed");
    await Bun.write(
      join(late, "extension.ts"),
      `import {defineOp} from "@botlake/core";
import {z} from "zod";
export default {name:"late",activate(ctx){ctx.resource({
  start(){ctx.register(defineOp({name:"too-late",input:z.compile(z.object({})),output:z.compile(z.null()),
    dependencies:["missing"],cli:{description:"late"},handler:()=>null}));},
  stop(){return Bun.write(${JSON.stringify(disposed)},"disposed").then(()=>{});}
});}};`,
    );
    expect(await host.botlake(["lake", "start", "--workspace", late], false)).toContain(
      "Registrations are closed",
    );
    expect(await Bun.file(disposed).text()).toBe("disposed");
    expect(lakes.parse(await host.botlake(["lake", "list"]))).toEqual([{ name: "healthy" }]);

    const failing = await host.workspace("failing", ["./extension.ts"]);
    const cleaned = join(failing, "cleaned");
    await Bun.write(
      join(failing, "extension.ts"),
      `export default {name:"cleanup",activate(ctx){
      ctx.resource({start(){},stop(){return Bun.write(${JSON.stringify(cleaned)},"cleaned").then(()=>{});}});
      ctx.resource({start(){},stop(){throw new Error("cleanup-boom");}});
    }};`,
    );
    await host.botlake(["lake", "start", "--workspace", failing]);
    expect(await host.botlake(["lake", "stop", "--workspace", failing], false)).toContain(
      "cleanup-boom",
    );
    expect(await Bun.file(cleaned).text()).toBe("cleaned");
    expect(lakes.parse(await host.botlake(["lake", "list"]))).toEqual([{ name: "healthy" }]);
    expect(await host.bl("healthy", "node", { command: "list" })).toEqual({
      nodes: [],
      total: 0,
      nextOffset: null,
    });
  } finally {
    await host.close();
  }
}, 60000);

test("unexpected member exit replaces only that worker without replaying its interrupted request", async () => {
  const host = await system();
  try {
    for (const name of ["alpha", "beta"]) {
      const path = await host.workspace(name, ["./extension.ts"]);
      await Bun.write(
        join(path, "extension.ts"),
        `import {defineOp} from "@botlake/core";
import {z} from "zod";
const instance=crypto.randomUUID();
export default {name:"probe",activate(ctx){
  ctx.register(defineOp({name:"instance",input:z.compile(z.object({})),output:z.compile(z.string()),cli:{description:"instance"},handler:()=>instance}));
  ctx.register(defineOp({name:"crash",input:z.compile(z.object({})),output:z.compile(z.null()),cli:{description:"crash"},handler(){
    ctx.graph.add({title:"once"});process.exit(23);
  }}));
  ctx.register(defineOp({name:"records",input:z.compile(z.object({})),output:z.compile(z.number()),cli:{description:"records"},handler:()=>ctx.graph.list().length}));
}};`,
      );
      await host.botlake(["lake", "start", "--workspace", path]);
    }

    const alpha = await host.bl("alpha", "instance", {});
    const beta = await host.bl("beta", "instance", {});
    const hostPid = status.parse(await host.botlake(["status"])).hostPid;
    expect(await host.bl("alpha", "crash", {}, false)).toContain("response ended");

    // Query readiness through the live daemon; never replay the interrupted op.
    let ready = false;
    for (let attempt = 0; attempt < 1000; attempt++) {
      const response = frame.parse(
        JSON.parse(
          await host.wire({
            protocol_version: 1,
            request_id: crypto.randomUUID(),
            operation: "lake-status",
            workspace: "alpha",
          }),
        ),
      );
      if (response.ok) {
        ready = true;
        break;
      }
    }
    expect(ready).toBe(true);
    expect(await host.bl("alpha", "instance", {})).not.toBe(alpha);
    expect(await host.bl("beta", "instance", {})).toBe(beta);
    expect(status.parse(await host.botlake(["status"])).hostPid).toBe(hostPid);
    expect(await host.bl("alpha", "records", {})).toBe(1);
  } finally {
    await host.close();
  }
}, 60000);

test("runtime quiesces all resources before scheduler drain and keeps dependencies alive through cleanup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "botlake-quiesce-"));
  const clock = new ManualClock();
  const runtime = new Runtime({ database: join(dir, "lake.sqlite"), clock });
  const release = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const order: string[] = [];
  const controller = new AbortController();
  try {
    await runtime.start([
      {
        name: "resource-lifecycle",
        activate(ctx) {
          ctx.scheduler.register("held", async () => {
            started.resolve();
            await release.promise;
            expect(controller.signal.aborted).toBe(true);
            ctx.graph.add({ title: "Drain still owns an open database" });
            order.push("drained");
          });
          ctx.resource({
            start() {
              ctx.scheduler.schedule("held", 0, "held");
            },
            quiesce() {
              order.push("dependency-quiesce");
              controller.abort();
            },
            stop() {
              order.push("dependency-stop");
            },
          });
          ctx.resource({
            start() {},
            quiesce() {
              order.push("consumer-quiesce");
              throw new Error("quiesce failure");
            },
            stop() {
              order.push("consumer-stop");
            },
          });
        },
      },
    ]);
    clock.advance(0);
    await started.promise;
    const stopping = runtime.stop();
    expect(order).toEqual(["consumer-quiesce", "dependency-quiesce"]);
    expect(controller.signal.aborted).toBe(true);
    release.resolve();
    try {
      await stopping;
      throw new Error("Expected quiesce error");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      if (!(error instanceof AggregateError)) throw error;
      expect(error.errors.map(String)).toEqual(["Error: quiesce failure"]);
    }
    expect(order).toEqual([
      "consumer-quiesce",
      "dependency-quiesce",
      "drained",
      "consumer-stop",
      "dependency-stop",
    ]);
    expect(runtime.errors).toEqual([]);
  } finally {
    release.resolve();
    await runtime.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
