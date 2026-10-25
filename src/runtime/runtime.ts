import { z } from "zod";

import { Fault, requireValue, type Json } from "../core/json.ts";
import { namedQuerySchema, type NamedQuery } from "../core/query.ts";
import { Graph, type GraphEvent } from "../core/store.ts";
import { parseArgs } from "./cli.ts";
import { systemClock, type Clock } from "./clock.ts";
import type { factSchema } from "./custody.ts";
import type { Op } from "./ops.ts";
import { Scheduler } from "./scheduler.ts";

export interface ProcessSpec {
  owner: string;
  key: string;
  command: string[];
  cwd?: string | undefined;
  env?: Record<string, string> | undefined;
  stdin?: string | undefined;
}
export type ProcessFact = z.infer<typeof factSchema>;
export interface Processes {
  launch(spec: ProcessSpec): Promise<ProcessFact>;
  get(handle: string): Promise<ProcessFact>;
  listOwned(owner: string): Promise<ProcessFact[]>;
  cancel(handle: string, owner: string, key: string): Promise<ProcessFact>;
  acknowledge(handle: string, owner: string, key: string): Promise<void>;
}
export interface Peers {
  call(workspace: string, op: string, input: Json): Promise<unknown>;
}
export interface Resource {
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
}
export interface Spool {
  name: string;
  requires?: string[];
  activate(ctx: Context): void | Promise<void>;
}
export interface Context {
  workspace: string;
  graph: Graph;
  clock: Clock;
  scheduler: Scheduler;
  processes: Processes;
  peers: Peers;
  register(op: Op): void;
  registerQuery(name: string, query: NamedQuery): void;
  namedQuery(name: string): NamedQuery | undefined;
  queryCatalog(): Record<string, NamedQuery>;
  resource(resource: Resource): void;
  subscribe(handler: (event: GraphEvent) => Promise<void> | void): void;
  bin(name: string, op: string): void;
}
const unavailable: Processes = {
  launch: () => Promise.reject(new Fault("process", "Mill custody is unavailable")),
  get: () => Promise.reject(new Fault("process", "Mill custody is unavailable")),
  listOwned: () => Promise.reject(new Fault("process", "Mill custody is unavailable")),
  cancel: () => Promise.reject(new Fault("process", "Mill custody is unavailable")),
  acknowledge: () => Promise.reject(new Fault("process", "Mill custody is unavailable")),
};
const metaOps = new Set(["help", "about", "prime", "primer"]);
export class Runtime {
  readonly graph: Graph;
  readonly scheduler: Scheduler;
  readonly context: Context;
  readonly errors: unknown[] = [];
  readonly bins = new Map<string, string>();
  private readonly queries = new Map<string, NamedQuery>();
  private readonly ops = new Map<string, Op>();
  private readonly resources: Resource[] = [];
  private readonly started: Resource[] = [];
  private readonly subscribers: ((event: GraphEvent) => Promise<void> | void)[] = [];
  private eventQueue = Promise.resolve();
  private phase: "registering" | "ready" | "stopping" | "stopped" = "registering";
  constructor(options: {
    database: string;
    workspace?: string;
    clock?: Clock;
    processes?: Processes;
    peers?: Peers;
  }) {
    const clock = options.clock ?? systemClock;
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
      graph: this.graph,
      scheduler: this.scheduler,
      clock,
      processes: options.processes ?? unavailable,
      peers: options.peers ?? {
        call: () => Promise.reject(new Fault("peer", "Peer routing is unavailable")),
      },
      register: (op) => {
        this.collecting();
        z.string().trim().min(1).parse(op.name);
        if (this.ops.has(op.name) || metaOps.has(op.name))
          throw new Fault("collision", `Duplicate op: ${op.name}`);
        this.ops.set(op.name, op);
      },
      registerQuery: (name, query) => {
        this.collecting();
        z.string().min(1).parse(name);
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
      bin: (name, op) => {
        this.collecting();
        if (this.bins.has(name)) throw new Fault("collision", `Duplicate bin: ${name}`);
        this.bins.set(name, op);
      },
    };
  }
  private collecting(): void {
    if (this.phase !== "registering") throw new Fault("lifecycle", "Registrations are closed");
  }
  async start(spools: Spool[]): Promise<void> {
    this.collecting();
    try {
      const selected = new Set<string>();
      for (const spool of spools) {
        if (selected.has(spool.name))
          throw new Fault("collision", `Duplicate spool: ${spool.name}`);
        selected.add(spool.name);
      }
      for (const spool of spools)
        for (const dependency of spool.requires ?? [])
          if (!selected.has(dependency))
            throw new Fault(
              "dependency",
              `${spool.name} requires explicitly selected ${dependency}`,
            );
      const visiting = new Set<string>();
      const ordered = new Map<string, Spool>();
      const byName = new Map(spools.map((spool) => [spool.name, spool]));
      function visit(spool: Spool): void {
        if (ordered.has(spool.name)) return;
        if (visiting.has(spool.name))
          throw new Fault("dependency", `Spool dependency cycle: ${spool.name}`);
        visiting.add(spool.name);
        for (const dependency of spool.requires ?? [])
          visit(requireValue(byName.get(dependency), `Unknown spool: ${dependency}`));
        visiting.delete(spool.name);
        ordered.set(spool.name, spool);
      }
      for (const spool of spools) visit(spool);
      for (const spool of ordered.values()) await spool.activate(this.context);
      for (const op of this.ops.values())
        for (const dependency of op.dependencies)
          if (!this.ops.has(dependency) && !metaOps.has(dependency))
            throw new Fault("dependency", `${op.name} requires ${dependency}`);
      for (const [name, op] of this.bins)
        if (!this.ops.has(op) && !metaOps.has(op))
          throw new Fault("dependency", `Bin ${name} requires ${op}`);
      this.scheduler.validate();
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
    options: { argv?: boolean; timeoutMs?: number; requestId?: string; signal?: AbortSignal } = {},
  ): Promise<unknown> {
    const began = this.context.clock.now();
    if (this.phase !== "ready") throw new Fault("lifecycle", "Runtime is not ready");
    if (metaOps.has(name)) {
      const path = Array.isArray(input)
        ? z.array(z.string()).parse(input)
        : typeof input === "string"
          ? [input]
          : [];
      return this.discovery(path[0], name, path.slice(1));
    }
    const op = requireValue(this.ops.get(name), `Unknown op: ${name}`);
    const payload = options.argv === true ? await parseArgs(op.cli, zStringArray(input)) : input;
    const timeout = options.timeoutMs ?? 30000;
    if (!Number.isFinite(timeout) || timeout <= 0)
      throw new Fault("deadline", "Deadline must be positive");
    const controller = new AbortController();
    const signal =
      options.signal === undefined
        ? controller.signal
        : AbortSignal.any([controller.signal, options.signal]);
    const deadline = began + timeout;
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
    const cancelTimer = this.context.clock.arm(deadline, () => {
      controller.abort(new Fault("deadline", `Op deadline exceeded: ${name}`));
    });
    if (this.context.clock.now() >= deadline)
      controller.abort(new Fault("deadline", `Op deadline exceeded: ${name}`));
    const clock = this.context.clock;
    function withinDeadline(): void {
      if (clock.now() >= deadline) throw new Fault("deadline", `Op deadline exceeded: ${name}`);
    }
    const cancel = (): void => {
      cancelTimer();
      if (rejectAbort !== undefined) signal.removeEventListener("abort", rejectAbort);
    };

    try {
      const result = await Promise.race([
        op.invoke(payload, this.context, {
          signal,
          deadline,
          requestId: options.requestId ?? crypto.randomUUID(),
        }),
        expired,
      ]);
      withinDeadline();
      if (isStream(result)) {
        const iterator = result[Symbol.asyncIterator]();
        const errors = this.errors;
        async function* timed(): AsyncGenerator {
          try {
            while (true) {
              const next = await Promise.race([iterator.next(), expired]);
              withinDeadline();
              if (next.done === true) break;
              yield next.value;
            }
          } finally {
            cancel();
            controller.abort(new Fault("cancelled", "Stream closed"));
            const closing = iterator.return?.();
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
}
function zStringArray(input: unknown): string[] {
  if (!Array.isArray(input) || input.some((value: unknown) => typeof value !== "string"))
    throw new Fault("argv", "Expected string argv");
  return input.map((value: unknown) => {
    if (typeof value !== "string") throw new Fault("argv", "Expected string argument");
    return value;
  });
}
export function isStream(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === "object" && value !== null && Symbol.asyncIterator in value;
}
