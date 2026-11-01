import { Fault, isFault, type Context, type Node, type ReferenceSource } from "@botlake/core";

import { changedSchema, snapshotSchema, sourceSchema, type ReferenceOptions } from "./model.ts";

interface Follow {
  /** Persistent owner identity. */
  lakeId: string;
  /** Current explicit route to that owner. */
  workspace: string;
  /** Source node ID to its currently selected local reference ID. */
  nodes: Map<string, string>;
  /** Concurrent explicit imports, counted per source node. */
  pending: Map<string, number>;
  /** Invalidation generation of selected or pending node IDs. */
  versions: Map<string, number>;
  /** Selected IDs awaiting one coalesced source read. */
  dirty: Set<string>;
  /** Lifetime of this owner route, including reconnect attempts. */
  controller: AbortController;
  /** Pulses after a connection state change; waiters inspect the new state. */
  changed: PromiseWithResolvers<void>;
  /** Stream generation covering a source observation. */
  generation: number;
  /** Last observed connection state and failure. */
  state: "connecting" | "live" | "offline";
  /** Actionable transport/source failure, independent of last retained facts. */
  error: { code: string; message: string } | null;
  /** Joined at shutdown; source failures are handled inside this task. */
  task: Promise<void>;
}

/** Follow selected owners; the injected Context owns routing, clocks and storage. */
export function referenceSync(ctx: Context, options: Required<ReferenceOptions>) {
  const follows = new Map<string, Follow>();
  const lifetime = new AbortController();
  const tasks = new Set<Promise<void>>();
  let started = false;
  let stopping = false;

  function sourceOf(follow: Follow, nodeId: string): ReferenceSource {
    return { lakeId: follow.lakeId, workspace: follow.workspace, nodeId };
  }

  function retire(follow: Follow): void {
    follow.controller.abort(
      new Fault("reference-route-changed", "The source route is no longer selected"),
    );
    if (follows.get(follow.lakeId) === follow) follows.delete(follow.lakeId);
  }

  function prune(follow: Follow): void {
    if (follow.nodes.size === 0 && follow.pending.size === 0) retire(follow);
  }

  function followSource(lakeId: string, workspace: string, relocate = false): Follow {
    const existing = follows.get(lakeId);
    if (existing !== undefined && (!relocate || existing.workspace === workspace)) return existing;
    if (existing !== undefined) retire(existing);
    const follow: Follow = {
      lakeId,
      workspace,
      nodes: new Map(),
      pending: new Map(),
      versions: new Map(),
      dirty: new Set(),
      controller: new AbortController(),
      changed: Promise.withResolvers<void>(),
      generation: 0,
      state: "connecting",
      error: null,
      task: Promise.resolve(),
    };
    let offset: number | null = 0;
    while (offset !== null) {
      const page = ctx.graph.references({ lakeId, limit: 1000, offset });
      for (const node of page.nodes)
        if (node.reference !== null) follow.nodes.set(node.reference.nodeId, node.id);
      offset = page.nextOffset;
    }
    follows.set(lakeId, follow);
    follow.task = run(follow);
    tasks.add(follow.task);
    void follow.task.then(() => tasks.delete(follow.task));
    return follow;
  }

  async function read(follow: Follow, ids: string[], signal: AbortSignal) {
    const snapshot = snapshotSchema.parse(
      await ctx.peers.call(
        follow.workspace,
        "reference",
        { command: "snapshot", ids },
        { signal, timeoutMs: options.requestTimeoutMs },
      ),
    );
    signal.throwIfAborted();
    if (snapshot.lakeId !== follow.lakeId)
      throw new Fault(
        "reference-owner-changed",
        "Workspace now routes to a different lake; import that owner explicitly",
        { workspace: follow.workspace, expected: follow.lakeId, actual: snapshot.lakeId },
      );
    const requested = new Set(ids);
    const returned = [...snapshot.nodes.map((node) => node.id), ...snapshot.missing];
    if (
      returned.length !== requested.size ||
      new Set(returned).size !== returned.length ||
      returned.some((id) => !requested.has(id))
    )
      throw new Fault(
        "reference-snapshot",
        "Source response does not account for each requested node exactly once",
      );
    return snapshot;
  }

  async function refresh(follow: Follow, ids: string[], signal: AbortSignal): Promise<void> {
    for (let offset = 0; offset < ids.length; offset += 100) {
      const snapshot = await read(follow, ids.slice(offset, offset + 100), signal);
      signal.throwIfAborted();
      ctx.graph.atomic(() => {
        for (const node of snapshot.nodes) {
          const selected = ctx.graph.reference(follow.lakeId, node.id);
          if (selected === null || selected.id !== follow.nodes.get(node.id)) continue;
          const { title, state, revision, kind } = node;
          ctx.graph.observeReference(sourceOf(follow, node.id), { title, state, revision, kind });
        }
        for (const id of snapshot.missing) {
          const selected = ctx.graph.reference(follow.lakeId, id);
          if (selected !== null && selected.id === follow.nodes.get(id))
            ctx.graph.observeReference(sourceOf(follow, id), null);
        }
      });
    }
  }

  async function run(follow: Follow): Promise<void> {
    const signal = follow.controller.signal;
    while (!signal.aborted) {
      ctx.graph.invalidateReferences({ lakeId: follow.lakeId });
      await attemptConnection(follow);
      if (signal.aborted) break;
      try {
        await pause(ctx, options.reconnectMs, signal);
      } catch {
        break;
      }
    }
  }

  async function attemptConnection(follow: Follow): Promise<void> {
    const signal = follow.controller.signal;
    const attempt = new AbortController();
    const attemptSignal = AbortSignal.any([signal, attempt.signal]);
    const pump = { active: false, task: Promise.resolve() };
    function scheduleFlush(): void {
      if (pump.active || attemptSignal.aborted || follow.dirty.size === 0) return;
      pump.active = true;
      pump.task = flush()
        .catch((error: unknown) => {
          attempt.abort(error);
        })
        .finally(() => {
          pump.active = false;
          scheduleFlush();
        });
    }
    const flush = async () => {
      await pause(ctx, 25, attemptSignal);
      while (follow.dirty.size > 0) {
        const ids = [...follow.dirty];
        follow.dirty.clear();
        await refresh(follow, ids, attemptSignal);
      }
    };
    try {
      for await (const frame of ctx.peers.watch(
        follow.workspace,
        ["nodes.changed"],
        attemptSignal,
      )) {
        if (frame.type === "ready") {
          follow.generation++;
          await read(follow, [], attemptSignal);
          await refresh(follow, [...follow.nodes.keys()], attemptSignal);
          follow.state = "live";
          follow.error = null;
          notify(follow);
          continue;
        }
        const data = changedSchema.parse(frame.data).ids;
        for (const id of data) {
          if (!follow.nodes.has(id) && !follow.pending.has(id)) continue;
          follow.versions.set(id, (follow.versions.get(id) ?? 0) + 1);
          if (follow.nodes.has(id)) follow.dirty.add(id);
        }
        scheduleFlush();
      }
      if (!signal.aborted) throw new Fault("reference-disconnected", "Source event stream ended");
    } catch (error) {
      if (!signal.aborted)
        follow.error = faultSummary(attempt.signal.aborted ? attempt.signal.reason : error);
    } finally {
      attempt.abort();
      await pump.task;
      follow.state = "offline";
      notify(follow);
      follow.dirty.clear();
      if (follows.get(follow.lakeId) === follow)
        ctx.graph.invalidateReferences({ lakeId: follow.lakeId });
    }
  }

  async function observe(
    follow: Follow,
    nodeId: string,
    requestSignal: AbortSignal,
    expectedId: string | null,
  ): Promise<Node> {
    const signal = AbortSignal.any([requestSignal, follow.controller.signal]);
    follow.pending.set(nodeId, (follow.pending.get(nodeId) ?? 0) + 1);
    try {
      for (;;) {
        await waitReady(follow, signal);
        const generation = follow.generation;
        const version = follow.versions.get(nodeId) ?? 0;
        const snapshot = await read(follow, [nodeId], signal);
        signal.throwIfAborted();
        if (
          follow.state !== "live" ||
          generation !== follow.generation ||
          version !== (follow.versions.get(nodeId) ?? 0)
        )
          continue;
        const existing = ctx.graph.reference(follow.lakeId, nodeId);
        if (expectedId !== null && existing?.id !== expectedId)
          throw new Fault(
            "reference-forgotten",
            "The local reference was removed while it was refreshing",
          );
        const node = snapshot.nodes[0];
        if (node === undefined && existing === null)
          throw new Fault("reference-missing", "Source node is absent or is itself a reference");
        const value =
          node === undefined
            ? null
            : { title: node.title, state: node.state, revision: node.revision, kind: node.kind };
        const observed = ctx.graph.observeReference(sourceOf(follow, nodeId), value);
        follow.nodes.set(nodeId, observed.id);
        return observed;
      }
    } finally {
      const remaining = (follow.pending.get(nodeId) ?? 1) - 1;
      if (remaining === 0) follow.pending.delete(nodeId);
      else follow.pending.set(nodeId, remaining);
      if (!follow.nodes.has(nodeId) && !follow.pending.has(nodeId)) follow.versions.delete(nodeId);
      prune(follow);
    }
  }

  ctx.subscribe((event) => {
    if (!started || stopping) return;
    for (const change of event.changes) {
      if (change.kind !== "node") continue;
      const before = change.before?.reference;
      const after = change.after?.reference;
      if (before !== undefined && before !== null && change.after === null) {
        const follow = follows.get(before.lakeId);
        if (follow !== undefined && follow.nodes.get(before.nodeId) === change.before?.id) {
          follow.nodes.delete(before.nodeId);
          follow.versions.delete(before.nodeId);
          follow.dirty.delete(before.nodeId);
          prune(follow);
        }
      }
      if (change.before === null && after !== undefined && after !== null) {
        const node = ctx.graph.reference(after.lakeId, after.nodeId);
        if (node !== null)
          followSource(after.lakeId, after.workspace).nodes.set(after.nodeId, node.id);
      }
    }
  });

  return {
    start() {
      started = true;
      let offset: number | null = 0;
      while (offset !== null) {
        const page = ctx.graph.references({ limit: 1000, offset });
        for (const node of page.nodes)
          if (node.reference !== null)
            followSource(node.reference.lakeId, node.reference.workspace);
        offset = page.nextOffset;
      }
    },
    async stop() {
      stopping = true;
      lifetime.abort(new Fault("reference-stopped", "Reference synchronization stopped"));
      for (const follow of follows.values()) {
        ctx.graph.invalidateReferences({ lakeId: follow.lakeId });
        retire(follow);
      }
      await Promise.all(tasks);
    },
    async add(workspace: string, nodeId: string, requestSignal: AbortSignal) {
      const signal = AbortSignal.any([requestSignal, lifetime.signal]);
      signal.throwIfAborted();
      const route = await ctx.peers.resolve(workspace, {
        signal,
        timeoutMs: options.requestTimeoutMs,
      });
      const owner = sourceSchema.parse(
        await ctx.peers.call(
          route.path,
          "reference",
          { command: "source" },
          { signal, timeoutMs: options.requestTimeoutMs },
        ),
      );
      signal.throwIfAborted();
      if (owner.lakeId === ctx.graph.lakeId)
        throw new Fault("reference-local", "Use the locally owned node directly");
      const follow = followSource(owner.lakeId, route.path, true);
      return observe(follow, nodeId, signal, null);
    },
    async refresh(id: string, requestSignal: AbortSignal) {
      const signal = AbortSignal.any([requestSignal, lifetime.signal]);
      signal.throwIfAborted();
      const node = ctx.graph.show(id);
      if (node.reference === null) throw new Fault("reference", "Expected a local reference node");
      const follow = followSource(node.reference.lakeId, node.reference.workspace);
      return observe(follow, node.reference.nodeId, signal, id);
    },
    status(lakeId: string | undefined, limit: number, offset: number) {
      const sources = [...follows.values()]
        .filter((follow) => lakeId === undefined || follow.lakeId === lakeId)
        .toSorted((a, b) => a.lakeId.localeCompare(b.lakeId));
      return {
        sources: sources.slice(offset, offset + limit).map((follow) => ({
          lakeId: follow.lakeId,
          workspace: follow.workspace,
          state: follow.state,
          references: follow.nodes.size,
          pending: follow.pending.size,
          error: follow.error,
        })),
        total: sources.length,
        nextOffset: offset + limit < sources.length ? offset + limit : null,
      };
    },
  };
}

// -- Private helpers --

function notify(follow: Follow): void {
  const changed = follow.changed;
  follow.changed = Promise.withResolvers<void>();
  changed.resolve();
}

function faultSummary(error: unknown): { code: string; message: string } {
  return isFault(error)
    ? { code: error.code, message: error.message }
    : { code: "reference-unavailable", message: String(error) };
}

async function waitReady(follow: Follow, signal: AbortSignal): Promise<void> {
  const combined = AbortSignal.any([signal, follow.controller.signal]);
  while (follow.state !== "live") {
    if (follow.error?.code === "reference-owner-changed")
      throw new Fault(follow.error.code, follow.error.message, {
        lakeId: follow.lakeId,
        workspace: follow.workspace,
      });
    await new Promise<void>((resolve, reject) => {
      combined.throwIfAborted();
      const abort = () => {
        reject(
          combined.reason instanceof Error ? combined.reason : new Error(String(combined.reason)),
        );
      };
      combined.addEventListener("abort", abort, { once: true });
      void follow.changed.promise.then(() => {
        combined.removeEventListener("abort", abort);
        resolve();
      });
    });
  }
  combined.throwIfAborted();
}

async function pause(ctx: Context, milliseconds: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const cancel = ctx.clock.arm(ctx.clock.now() + milliseconds, () => {
      signal.removeEventListener("abort", abort);
      resolve();
    });
    function abort() {
      cancel();
      reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)));
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}
