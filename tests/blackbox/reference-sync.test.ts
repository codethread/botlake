import { test, expect } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  Fault,
  ManualClock,
  Runtime,
  isStream,
  requireValue,
  type Clock,
  type EventFrame,
  type Peers,
} from "@botlake/core";
import { batteries } from "@botlake/extension-batteries";
import { identity } from "@botlake/extension-identity";
import { references } from "@botlake/extension-references";
import { work, workReferenceProjections } from "@botlake/extension-work";
import { z } from "zod";

import { rejected } from "./assert.ts";

const identifier = z.object({ id: z.string() });
const acknowledgement = z.object({
  id: z.string(),
  state: z.string(),
  reference: z.object({ workspace: z.string(), status: z.string() }),
});
const referencePage = z.object({ nodes: z.array(acknowledgement), total: z.number() });
const frameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready"), events: z.array(z.string()) }),
  z.object({ type: z.literal("event"), event: z.string(), at: z.number(), data: z.json() }),
]);
const snapshotRequest = z.object({ command: z.literal("snapshot"), ids: z.array(z.string()) });

interface Gate {
  /** Operation response to hold after the real owner computed it. */
  command: "source" | "snapshot";
  /** Route whose next matching response is held. */
  route: string;
  /** Source node selected by a snapshot gate; null for owner discovery. */
  nodeId: string | null;
  /** A late response ignores cancellation until explicitly released. */
  late: boolean;
  /** Whether this one-shot gate has captured a response. */
  captured: boolean;
  /** Actual cancellation signal supplied through the public Peers interface. */
  signal: AbortSignal | null;
  /** Resolves after the owner computed the held response. */
  reached: PromiseWithResolvers<void>;
  /** Lets the held response finish. */
  release: PromiseWithResolvers<void>;
}

test("an import retries when a committed owner invalidation races its snapshot", async () => {
  const lakes = await pairedLakes();
  try {
    const task = await createTask(lakes.owner, "Publish source contract");
    const gate = lakes.hold("snapshot", lakes.ownerRoute, task.id);
    const importing = lakes.consumer.invoke("reference", {
      command: "add",
      workspace: lakes.ownerRoute,
      node: task.id,
    });
    await gate.reached.promise;
    const processed = lakes.afterEvent(task.id);
    await lakes.owner.invoke("work", { command: "close", id: task.id, by: "test" });
    await processed;
    gate.release.resolve();
    const observed = acknowledgement.parse(await importing);
    expect(observed.state).toBe("closed");
    expect(lakes.reads.filter((read) => read.ids.includes(task.id))).toHaveLength(2);
    expect(
      referencePage.parse(await lakes.consumer.invoke("reference", { command: "list" })).total,
    ).toBe(1);
    const dependent = identifier.parse(
      await lakes.consumer.invoke("work", {
        command: "create",
        title: "Use source contract",
        prerequisites: [observed.id],
        by: "test",
      }),
    );
    expect(
      await lakes.consumer.invoke("work", { command: "show", id: dependent.id }),
    ).toMatchObject({ ready: true });
  } finally {
    await lakes.close();
  }
});

for (const operation of ["add", "refresh"] as const) {
  test(`an in-flight ${operation} cannot commit a response from a retired source route`, async () => {
    const lakes = await pairedLakes();
    try {
      const first = await createTask(lakes.owner, "Already selected");
      const second = await createTask(lakes.owner, "Pending selection");
      const original = acknowledgement.parse(
        await lakes.consumer.invoke("reference", {
          command: "add",
          workspace: lakes.ownerRoute,
          node: first.id,
        }),
      );
      const heldNode = operation === "add" ? second.id : first.id;
      const gate = lakes.hold("snapshot", lakes.ownerRoute, heldNode, true);
      const pending = rejected(
        lakes.consumer.invoke(
          "reference",
          operation === "add"
            ? { command: "add", workspace: lakes.ownerRoute, node: heldNode }
            : { command: "refresh", id: original.id },
        ),
      );
      await gate.reached.promise;
      const relocated = acknowledgement.parse(
        await lakes.consumer.invoke("reference", {
          command: "add",
          workspace: lakes.movedRoute,
          node: first.id,
        }),
      );
      expect(relocated.id).toBe(original.id);
      expect(relocated.reference.workspace).toBe(lakes.movedRoute);
      expect(gate.signal?.aborted).toBe(true);
      gate.release.resolve();
      expect((await pending).message).toContain("route");
      const page = referencePage.parse(
        await lakes.consumer.invoke("reference", { command: "list" }),
      );
      expect(page.total).toBe(1);
      expect(page.nodes[0]?.reference.workspace).toBe(lakes.movedRoute);
      expect(page.nodes[0]?.reference.status).toBe("current");
    } finally {
      await lakes.close();
    }
  });
}

test("a background snapshot finishing after forget cannot recreate the local reference", async () => {
  const lakes = await pairedLakes();
  try {
    const task = await createTask(lakes.owner, "Source node");
    const imported = acknowledgement.parse(
      await lakes.consumer.invoke("reference", {
        command: "add",
        workspace: lakes.ownerRoute,
        node: task.id,
      }),
    );
    const gate = lakes.hold("snapshot", lakes.ownerRoute, task.id, true);
    const processed = lakes.afterEvent(task.id);
    await lakes.owner.invoke("work", {
      command: "update",
      id: task.id,
      title: "Updated source node",
    });
    await processed;
    await lakes.clock.advanceNext(25);
    await gate.reached.promise;
    expect(
      await lakes.consumer.invoke("reference", { command: "forget", id: imported.id }),
    ).toEqual({ id: imported.id, forgotten: true });
    await lakes.consumer.drain();
    gate.release.resolve();
    await lakes.consumer.stop();
    const reopened = new Runtime({
      database: lakes.localDatabase,
      workspace: lakes.consumerRoute,
      clock: lakes.clock.clock,
      peers: lakes.peers,
    });
    try {
      await reopened.start([references()]);
      expect(await reopened.invoke("reference", { command: "list" })).toMatchObject({
        nodes: [],
        total: 0,
        nextOffset: null,
      });
    } finally {
      await reopened.stop();
    }
    expect(await lakes.owner.invoke("work", { command: "show", id: task.id })).toMatchObject({
      item: { title: "Updated source node" },
    });
  } finally {
    await lakes.close();
  }
});

test("an old refresh cannot adopt a new local reference after forget and re-import", async () => {
  const lakes = await pairedLakes();
  try {
    const task = await createTask(lakes.owner, "Source with a new selection");
    const original = acknowledgement.parse(
      await lakes.consumer.invoke("reference", {
        command: "add",
        workspace: lakes.ownerRoute,
        node: task.id,
      }),
    );
    const gate = lakes.hold("snapshot", lakes.ownerRoute, task.id);
    const pending = rejected(
      lakes.consumer.invoke("reference", { command: "refresh", id: original.id }),
    );
    await gate.reached.promise;
    await lakes.consumer.invoke("reference", { command: "forget", id: original.id });
    await lakes.consumer.drain();
    const selected = acknowledgement.parse(
      await lakes.consumer.invoke("reference", {
        command: "add",
        workspace: lakes.ownerRoute,
        node: task.id,
      }),
    );
    expect(selected.id).not.toBe(original.id);
    gate.release.resolve();
    expect((await pending).message).toContain("removed");
    const page = referencePage.parse(await lakes.consumer.invoke("reference", { command: "list" }));
    expect(page.total).toBe(1);
    expect(page.nodes[0]?.id).toBe(selected.id);
  } finally {
    await lakes.close();
  }
});

test("an import waiting through failed connections completes after clock-driven reconnects", async () => {
  const lakes = await pairedLakes(2);
  try {
    const task = await createTask(lakes.owner, "Source after recovery");
    const pending = lakes.consumer.invoke("reference", {
      command: "add",
      workspace: lakes.ownerRoute,
      node: task.id,
    });
    await lakes.clock.advanceNext(500);
    await lakes.clock.advanceNext(500);
    const observed = acknowledgement.parse(await pending);
    expect(observed.reference.status).toBe("current");
    expect(lakes.watchAttempts()).toBe(3);
    expect(lakes.reads.filter((read) => read.ids.includes(task.id))).toHaveLength(1);
    expect(
      referencePage.parse(await lakes.consumer.invoke("reference", { command: "list" })).total,
    ).toBe(1);
  } finally {
    await lakes.close();
  }
});

for (const command of ["source", "snapshot"] as const) {
  test(`shutdown aborts an unresponsive ${command} peer read`, async () => {
    const lakes = await pairedLakes();
    try {
      const task = await createTask(lakes.owner, "Source node");
      const imported =
        command === "snapshot"
          ? acknowledgement.parse(
              await lakes.consumer.invoke("reference", {
                command: "add",
                workspace: lakes.ownerRoute,
                node: task.id,
              }),
            )
          : null;
      const gate = lakes.hold(command, lakes.ownerRoute, command === "snapshot" ? task.id : null);
      const pending = rejected(
        lakes.consumer.invoke(
          "reference",
          imported === null
            ? { command: "add", workspace: lakes.ownerRoute, node: task.id }
            : { command: "refresh", id: imported.id },
        ),
      );
      await gate.reached.promise;
      await lakes.consumer.stop();
      expect(gate.signal?.aborted).toBe(true);
      expect((await pending).message).toContain("stopped");
    } finally {
      await lakes.close();
    }
  });
}

// -- Private helpers --

async function pairedLakes(failedConnections = 0) {
  const directory = await mkdtemp(join(tmpdir(), "botlake-reference-sync-"));
  const ownerRoute = join(directory, "owner");
  const movedRoute = join(directory, "moved");
  const consumerRoute = join(directory, "consumer");
  for (const route of [ownerRoute, movedRoute, consumerRoute]) await mkdir(route);
  const clock = notifyingClock();
  const owner = new Runtime({
    database: join(ownerRoute, "world.db"),
    workspace: ownerRoute,
    clock: clock.clock,
  });
  await owner.start([
    batteries(),
    identity(),
    work(),
    references({ projections: workReferenceProjections }),
  ]);
  const routes = new Map([
    [ownerRoute, owner],
    [movedRoute, owner],
  ]);
  const gates: Gate[] = [];
  const processed: { nodeId: string; done: PromiseWithResolvers<void> }[] = [];
  const reads: { route: string; ids: string[] }[] = [];
  let attempts = 0;
  const peers: Peers = {
    async resolve(workspace) {
      if (!routes.has(workspace)) throw new Fault("peer", `Unknown source route: ${workspace}`);
      return { path: workspace, name: workspace };
    },
    async call(workspace, op, input, options) {
      const source = routes.get(workspace);
      if (source === undefined) throw new Error(`Unknown source route: ${workspace}`);
      const callOptions = requireValue(options, "Reference reads must provide invocation options");
      const signal = requireValue(callOptions.signal, "Reference reads must provide cancellation");
      const value = await source.invoke(op, input, {
        signal,
        ...(callOptions.timeoutMs === undefined ? {} : { timeoutMs: callOptions.timeoutMs }),
      });
      const request = snapshotRequest.safeParse(input);
      if (request.success) reads.push({ route: workspace, ids: request.data.ids });
      const command = z.object({ command: z.string() }).parse(input).command;
      const gate = gates.find(
        (candidate) =>
          !candidate.captured &&
          candidate.route === workspace &&
          candidate.command === command &&
          (candidate.nodeId === null ||
            (request.success && request.data.ids.includes(candidate.nodeId))),
      );
      if (gate !== undefined) {
        gate.captured = true;
        gate.signal = signal;
        gate.reached.resolve();
        if (gate.late) await gate.release.promise;
        else await abortable(gate.release.promise, signal);
      }
      return value;
    },
    async *watch(workspace, events, signal) {
      attempts++;
      if (attempts <= failedConnections) throw new Fault("peer", "Source temporarily unavailable");
      const source = routes.get(workspace);
      if (source === undefined) throw new Error(`Unknown source route: ${workspace}`);
      const stream = await source.invoke("events", { command: "stream", events }, { signal });
      if (!isStream(stream)) throw new Error("Expected actual source event stream");
      for await (const value of stream) {
        const frame: EventFrame = frameSchema.parse(value);
        yield frame;
        if (frame.type !== "event") continue;
        const ids = z.object({ ids: z.array(z.string()) }).parse(frame.data).ids;
        for (const waiter of processed) if (ids.includes(waiter.nodeId)) waiter.done.resolve();
      }
    },
  };
  const localDatabase = join(consumerRoute, "world.db");
  const consumer = new Runtime({
    database: localDatabase,
    workspace: consumerRoute,
    clock: clock.clock,
    peers,
  });
  await consumer.start([
    batteries(),
    identity(),
    work(),
    references({ projections: workReferenceProjections, reconnectMs: 500 }),
  ]);
  return {
    owner,
    consumer,
    clock,
    peers,
    ownerRoute,
    movedRoute,
    consumerRoute,
    localDatabase,
    reads,
    hold(command: Gate["command"], route: string, nodeId: string | null, late = false): Gate {
      const gate: Gate = {
        command,
        route,
        nodeId,
        late,
        captured: false,
        signal: null,
        reached: Promise.withResolvers<void>(),
        release: Promise.withResolvers<void>(),
      };
      gates.push(gate);
      return gate;
    },
    afterEvent(nodeId: string): Promise<void> {
      const done = Promise.withResolvers<void>();
      processed.push({ nodeId, done });
      return done.promise;
    },
    watchAttempts: () => attempts,
    async close() {
      for (const gate of gates) gate.release.resolve();
      await consumer.stop();
      await owner.stop();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function notifyingClock() {
  const manual = new ManualClock();
  interface Arm {
    at: number;
    delay: number;
    active: boolean;
    claimed: boolean;
  }
  const queued: Arm[] = [];
  const pending: { delay: number; done: PromiseWithResolvers<Arm> }[] = [];
  const clock: Clock = {
    now: () => manual.now(),
    arm(at, run) {
      const arm: Arm = { at, delay: at - manual.now(), active: true, claimed: false };
      const cancel = manual.arm(at, () => {
        arm.active = false;
        run();
      });
      queued.push(arm);
      const waiter = pending.find((entry) => entry.delay === arm.delay);
      if (waiter !== undefined) {
        pending.splice(pending.indexOf(waiter), 1);
        arm.claimed = true;
        waiter.done.resolve(arm);
      }
      return () => {
        arm.active = false;
        cancel();
      };
    },
  };
  return {
    clock,
    async advanceNext(delay: number) {
      let arm = queued.find((entry) => entry.delay === delay && entry.active && !entry.claimed);
      if (arm === undefined) {
        const done = Promise.withResolvers<Arm>();
        pending.push({ delay, done });
        arm = await done.promise;
      }
      arm.claimed = true;
      expect(arm.active).toBe(true);
      manual.advance(arm.at);
    },
  };
}

async function abortable(operation: Promise<void>, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => {
      reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)));
    };
    signal.addEventListener("abort", abort, { once: true });
    void operation.then(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    });
  });
}

async function createTask(owner: Runtime, title: string) {
  const task = identifier.parse(
    await owner.invoke("work", { command: "create", title, by: "test" }),
  );
  await owner.drain();
  return task;
}
