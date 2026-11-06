// Run: bun scripts/runtime-extension-smoke.ts — public runtime composition over disposable SQLite.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Runtime, runtimeExtension, type Extension } from "@botlake/core";

const dir = await mkdtemp(join(tmpdir(), "botlake-runtime-extension-"));
const runtimes: Runtime[] = [];
const order: string[] = [];
const entered = Promise.withResolvers<void>();
const release = Promise.withResolvers<void>();
let activations = 0;
const binding = runtimeExtension({
  name: "records",
  async activate(ctx) {
    activations++;
    entered.resolve();
    await release.promise;
    ctx.resource({
      start() {
        order.push("records/start");
      },
      stop() {
        order.push("records/stop");
      },
    });
    return {
      add(title: string) {
        return ctx.graph.add({ title });
      },
      count() {
        return ctx.graph.count();
      },
    };
  },
});
const consumer: Extension = {
  name: "consumer",
  requires: [binding.name],
  activate(ctx) {
    const records = binding.instance(ctx);
    assert.equal(records, binding.instance(ctx));
    order.push("consumer/activate");
    ctx.resource({
      start() {
        order.push("consumer/start");
      },
      stop() {
        assert.equal(binding.instance(ctx), records);
        order.push("consumer/stop");
      },
    });
  },
};

function runtime(database: string): Runtime {
  const value = new Runtime({ database: join(dir, `${database}.sqlite`), workspace: dir });
  runtimes.push(value);
  return value;
}

try {
  assert.equal(activations, 0, "Configuration must not activate bindings");
  const alpha = runtime("alpha");
  assert.throws(() => binding.instance(alpha.context), /exact binding/u);
  const starting = alpha.start([consumer, binding]);
  await entered.promise;
  assert.throws(() => binding.instance(alpha.context), /not activated/u);
  release.resolve();
  await starting;
  assert.deepEqual(order, ["consumer/activate", "records/start", "consumer/start"]);
  const first = binding.instance(alpha.context);
  first.add("Durable fact, not binding state");
  assert.equal(first.count(), 1);

  const beta = runtime("beta");
  await beta.start([consumer, binding]);
  assert.notEqual(binding.instance(beta.context), first);
  assert.equal(binding.instance(beta.context).count(), 0);
  assert.equal(first.count(), 1);
  assert.equal(activations, 2);

  await alpha.stop();
  assert.deepEqual(order.slice(-2), ["consumer/stop", "records/stop"]);
  const reopened = runtime("alpha");
  await reopened.start([consumer, binding]);
  assert.notEqual(binding.instance(reopened.context), first);
  assert.equal(binding.instance(reopened.context).count(), 1);

  const missing = runtime("missing");
  await assert.rejects(missing.start([consumer]), /requires explicitly selected records/u);

  const wrongBinding = runtimeExtension({ name: binding.name, activate: () => ({}) });
  const mismatched = runtime("mismatched");
  await assert.rejects(mismatched.start([wrongBinding, consumer]), /exact binding/u);
  assert.throws(() => binding.instance(mismatched.context), /not activated/u);

  const failed = runtimeExtension({
    name: "failed",
    async activate() {
      throw new Error("activation failed");
    },
  });
  const rejected = runtime("rejected");
  await assert.rejects(rejected.start([failed]), /activation failed/u);
  assert.throws(() => failed.instance(rejected.context), /not activated/u);

  const unavailable = runtimeExtension<undefined>({
    name: "undefined-value",
    activate(): undefined {
      return undefined;
    },
  });
  const empty = runtime("empty");
  assert.throws(() => {
    unavailable.instance(empty.context);
  }, /not activated/u);
  await empty.start([unavailable]);
  unavailable.instance(empty.context);

  const startupOrder: string[] = [];
  const startupFailure = runtimeExtension({
    name: "startup-failure",
    activate(ctx) {
      ctx.resource({
        start() {
          startupOrder.push("start");
          throw new Error("resource failed");
        },
        stop() {
          startupOrder.push("stop");
        },
      });
      return {};
    },
  });
  await assert.rejects(runtime("startup-failure").start([startupFailure]), /resource failed/u);
  assert.deepEqual(startupOrder, ["start", "stop"]);
} finally {
  release.resolve();
  for (const value of runtimes) await value.stop();
  await rm(dir, { recursive: true, force: true });
}

console.log(
  "Runtime extension smoke verified: inert configuration; awaited publication; exact-binding prerequisites; context isolation; restart persistence; activation failure; resource lifecycle",
);
