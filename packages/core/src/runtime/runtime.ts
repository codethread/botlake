import { AsyncLocalStorage } from "node:async_hooks";

import { DepGraph, DepGraphCycleError } from "dependency-graph";
import { z } from "zod";

import { Fault, requireValue } from "../core/json.ts";
import { namedQuerySchema, type NamedQuery } from "../core/query.ts";
import { Graph, type GraphEvent } from "../core/store.ts";
import { Bins } from "./bins.ts";
import { parseArgs, validateCommand } from "./cli.ts";
import { systemClock, type Clock } from "./clock.ts";
import type { Context, Invocation, Op, Peers, Processes, Resource, Extension } from "./context.ts";
// oxlint-disable-next-line import/max-dependencies -- Runtime composes core services and invocation scope.
import { Scheduler } from "./scheduler.ts";

const operationNameSchema = z.compile(z.string().trim().min(1));
const queryNameSchema = z.compile(z.string().min(1));
const argvSchema = z.compile(z.array(z.string()));

const unavailable: Processes = {
  launch: () => Promise.reject(new Fault("process", "Botlake custody is unavailable")),
  get: () => Promise.reject(new Fault("process", "Botlake custody is unavailable")),
  listOwned: () => Promise.reject(new Fault("process", "Botlake custody is unavailable")),
  cancel: () => Promise.reject(new Fault("process", "Botlake custody is unavailable")),
  acknowledge: () => Promise.reject(new Fault("process", "Botlake custody is unavailable")),
};

const metaOps = new Set(["help", "about", "prime", "primer"]);

export function isStream(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === "object" && value !== null && Symbol.asyncIterator in value;
}

export class Runtime {
  readonly graph: Graph;
  readonly scheduler: Scheduler;
  readonly context: Context;
  readonly errors: unknown[] = [];
  private readonly invocationEnv = new AsyncLocalStorage<Context["env"]>();
  private readonly queries = new Map<string, NamedQuery>();
  private readonly ops = new Map<string, Op>();
  private readonly resources: Resource[] = [];
  private readonly started: Resource[] = [];
  private readonly subscribers: ((event: GraphEvent) => Promise<void> | void)[] = [];
  private eventQueue = Promise.resolve();
  private phase: "registering" | "starting" | "ready" | "stopping" | "stopped" = "registering";

  constructor(options: {
    database: string;
    workspace?: string;
    env?: Record<string, string | undefined>;
    clock?: Clock;
    processes?: Processes;
    peers?: Peers;
  }) {
    const bins = new Bins();
    const clock = options.clock ?? systemClock;
    const env = { lake: { ...(options.env ?? process.env) }, bl: {} };
    const invocationEnv = this.invocationEnv;

    this.graph = new Graph(
      options.database,
      () => clock.now(),
      (event) => {
        this.publish(event);
      },
    );

    this.scheduler = new Scheduler(this.graph, clock, (error) => {
      this.errors.push(error);
    });

    this.context = {
      workspace: options.workspace ?? process.cwd(),
      get env() {
        return invocationEnv.getStore() ?? env;
      },
      graph: this.graph,
      scheduler: this.scheduler,
      clock,
      processes: options.processes ?? unavailable,
      peers: options.peers ?? {
        resolve: () => Promise.reject(new Fault("peer", "Peer routing is unavailable")),
        call: () => Promise.reject(new Fault("peer", "Peer routing is unavailable")),
      },
      register: (op) => {
        this.collecting();
        operationNameSchema.parse(op.name);
        if (this.ops.has(op.name) || metaOps.has(op.name))
          throw new Fault("collision", `Duplicate op: ${op.name}`);

        this.ops.set(op.name, { ...op, cli: validateCommand(op.cli) });
      },
      registerQuery: (name, query) => {
        this.collecting();
        queryNameSchema.parse(name);
        if (this.queries.has(name)) throw new Fault("collision", `Duplicate query: ${name}`);

        this.queries.set(name, namedQuerySchema.parse(query));
      },
      namedQuery: (name) => this.queries.get(name),
      queryCatalog: () => Object.fromEntries(this.queries),
      resource: (resource) => {
        this.collecting();

        this.resources.push(resource);
      },
      subscribe: (handler) => {
        this.collecting();

        this.subscribers.push(handler);
      },
      bin: (name, bin) => {
        this.collecting();

        bins.register(name, bin);
      },
    };

    this.context.register(bins.operation());
  }

  async start(extensions: Extension[]): Promise<void> {
    this.collecting();
    try {
      const selected = new DepGraph<Extension>();
      for (const extension of extensions) {
        if (selected.hasNode(extension.name))
          throw new Fault("collision", `Duplicate extension: ${extension.name}`);
        selected.addNode(extension.name, extension);
      }
      for (const extension of extensions)
        for (const dependency of extension.requires ?? []) {
          if (!selected.hasNode(dependency))
            throw new Fault(
              "dependency",
              `${extension.name} requires explicitly selected ${dependency}`,
            );
          selected.addDependency(extension.name, dependency);
        }

      let ordered: string[];
      try {
        ordered = selected.overallOrder();
      } catch (error) {
        if (error instanceof DepGraphCycleError)
          throw new Fault(
            "dependency",
            `Extension dependency cycle: ${error.cyclePath.join(" -> ")}`,
          );
        throw error;
      }

      for (const name of ordered) await selected.getNodeData(name).activate(this.context);
      for (const op of this.ops.values())
        for (const dependency of op.dependencies)
          if (!this.ops.has(dependency) && !metaOps.has(dependency))
            throw new Fault("dependency", `${op.name} requires ${dependency}`);
      this.scheduler.validate();

      this.phase = "starting";
      for (const resource of this.resources) {
        this.started.push(resource);
        await resource.start();
      }
      this.scheduler.start();
      this.phase = "ready";
    } catch (error) {
      try {
        await this.stop();
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], "Runtime startup and cleanup failed", {
          cause: cleanup,
        });
      }
      throw error;
    }
  }

  discovery(name?: string, tier = "help", path: string[] = []): unknown {
    const ops =
      name === undefined
        ? [...this.ops.values()]
        : [requireValue(this.ops.get(name), `Unknown op: ${name}`)];
    return ops.map((op) => {
      let command = op.cli;
      for (const part of path)
        command = requireValue(command.commands?.[part], `Unknown subcommand: ${part}`);
      return {
        name: op.name,
        cli: command,
        stream: op.stream,
        deadline: op.deadline,
        ...(tier === "about" || tier === "prime" || tier === "primer"
          ? { about: op.about ?? "", jsonSchema: op.jsonSchema?.() ?? null }
          : {}),
        ...(tier === "prime" || tier === "primer" ? { primer: op.primer ?? "" } : {}),
      };
    });
  }
  async invoke(
    name: string,
    input: unknown,
    options: {
      argv?: boolean;
      timeoutMs?: number;
      requestId?: string;
      signal?: AbortSignal;
      payloads?: Record<string, string>;
      cwd?: string;
      worktreeRoot?: string;
      gitCommonDir?: string;
      env?: Record<string, string | undefined>;
      terminal?: Invocation["terminal"];
    } = {},
  ): Promise<unknown> {
    const began = this.context.clock.now();

    if (this.phase !== "ready") throw new Fault("lifecycle", "Runtime is not ready");
    const payloadSlots = Object.keys(options.payloads ?? {});
    if (payloadSlots.length > 0 && (metaOps.has(name) || options.argv !== true))
      throw new Fault("payload", `Unused payload: ${payloadSlots.join(", ")}`);

    if (metaOps.has(name)) {
      const path = Array.isArray(input)
        ? argvSchema.parse(input)
        : typeof input === "string"
          ? [input]
          : [];
      return this.discovery(path[0], name, path.slice(1));
    }

    if (options.argv === true) {
      const args = zStringArray(input);
      if (args.at(-1) === "--help" || args.at(-1) === "-h") {
        const path = args.slice(0, -1);
        if (path.some((part) => part.startsWith("-")) || payloadSlots.length > 0)
          throw new Fault(
            "argv",
            "Use help OP [SUBCOMMAND...] without operation flags or payloads",
          );
        return this.discovery(name, "help", path);
      }
    }

    const op = requireValue(this.ops.get(name), `Unknown op: ${name}`);
    const env = { lake: this.context.env.lake, bl: { ...options.env } };
    const timeout = options.timeoutMs ?? (op.deadline === "unbounded" ? null : 30000);
    if (timeout !== null && (!Number.isFinite(timeout) || timeout <= 0))
      throw new Fault("deadline", "Deadline must be positive");

    const controller = new AbortController();
    const signal =
      options.signal === undefined
        ? controller.signal
        : AbortSignal.any([controller.signal, options.signal]);
    const deadline = timeout === null ? null : began + timeout;

    let rejectAbort: (() => void) | undefined;
    const expired = new Promise<never>((_, reject) => {
      rejectAbort = () => {
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : new Fault("cancelled", "Invocation aborted", String(signal.reason)),
        );
      };
      signal.addEventListener("abort", rejectAbort, { once: true });
      if (signal.aborted) rejectAbort();
    });

    const cancelTimer =
      deadline === null
        ? undefined
        : this.context.clock.arm(deadline, () => {
            controller.abort(new Fault("deadline", `Op deadline exceeded: ${name}`));
          });
    if (deadline !== null && this.context.clock.now() >= deadline)
      controller.abort(new Fault("deadline", `Op deadline exceeded: ${name}`));

    const clock = this.context.clock;
    function withinDeadline(): void {
      if (deadline !== null && clock.now() >= deadline)
        throw new Fault("deadline", `Op deadline exceeded: ${name}`);
    }
    const cancel = (): void => {
      cancelTimer?.();
      if (rejectAbort !== undefined) signal.removeEventListener("abort", rejectAbort);
    };

    try {
      const result = await Promise.race([
        (async () => {
          const payload =
            options.argv === true
              ? await parseArgs(op.cli, zStringArray(input), options.payloads)
              : input;
          signal.throwIfAborted();
          return this.invocationEnv.run(env, () =>
            op.invoke(payload, this.context, {
              signal,
              deadline,
              requestId: options.requestId ?? crypto.randomUUID(),
              cwd: options.cwd ?? this.context.workspace,
              worktreeRoot: options.worktreeRoot,
              gitCommonDir: options.gitCommonDir,
              terminal: options.terminal ?? { isTTY: false, columns: null },
            }),
          );
        })(),
        expired,
      ]);
      withinDeadline();

      if (isStream(result)) {
        const invocationEnv = this.invocationEnv;
        const iterator = invocationEnv.run(env, () => result[Symbol.asyncIterator]());
        const errors = this.errors;
        async function* timed(): AsyncGenerator {
          try {
            while (true) {
              const next = await Promise.race([
                invocationEnv.run(env, () => iterator.next()),
                expired,
              ]);
              withinDeadline();
              if (next.done === true) break;
              yield next.value;
            }
          } finally {
            cancel();
            controller.abort(new Fault("cancelled", "Stream closed"));
            const closing = invocationEnv.run(env, () => iterator.return?.());
            if (closing !== undefined)
              void Promise.resolve(closing).catch((error: unknown) => {
                errors.push(error);
              });
          }
        }
        return timed();
      }

      cancel();
      return result;
    } catch (error) {
      cancel();
      throw error;
    }
  }

  async drain(): Promise<void> {
    await this.scheduler.drain();
    await this.eventQueue;
  }

  async stop(): Promise<void> {
    if (this.phase === "stopped") return;
    this.phase = "stopping";
    await this.scheduler.stop();

    const errors: unknown[] = [];
    for (const resource of this.started.toReversed()) {
      try {
        await resource.stop();
      } catch (error) {
        errors.push(error);
      }
    }

    await this.eventQueue;
    this.graph.close();
    this.phase = "stopped";
    if (errors.length > 0) throw new AggregateError(errors, "Resource shutdown failed");
  }

  // -- Private helpers --

  private collecting(): void {
    if (this.phase !== "registering") throw new Fault("lifecycle", "Registrations are closed");
  }

  private publish(event: GraphEvent): void {
    this.eventQueue = this.eventQueue.then(async () => {
      for (const subscriber of this.subscribers) {
        try {
          await subscriber(event);
        } catch (error) {
          this.errors.push(error);
        }
      }
    });
  }
}

// -- Private helpers --

function zStringArray(input: unknown): string[] {
  const parsed = argvSchema.safeParse(input);
  if (!parsed.success) throw new Fault("argv", "Expected string argv");
  return parsed.data;
}
