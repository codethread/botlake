import type { z } from "zod";

import type { Json } from "../core/json.ts";
import type { NamedQuery } from "../core/query.ts";
import type { Graph, GraphEvent } from "../core/store.ts";
import type { Bin } from "./bins.ts";
import type { Command } from "./cli.ts";
import type { Clock } from "./clock.ts";
import type { factSchema } from "./custody.ts";
import type { EventDefinition, EventHandler, EventPhase } from "./events.ts";
import type { Scheduler } from "./scheduler.ts";

export interface Invocation {
  signal: AbortSignal;
  requestId: string;
  /** Absolute clock time, or null when only caller cancellation applies. */
  deadline: number | null;
  cwd: string;
  worktreeRoot?: string | undefined;
  gitCommonDir?: string | undefined;
  terminal: { isTTY: boolean; columns: number | null };
}

export interface Op {
  name: string;
  cli: Command;
  about?: string | undefined;
  primer?: string | undefined;
  dependencies: string[];
  stream: boolean;
  /** Standard operations default to 30s; unbounded operations own their wait budget. */
  deadline: "standard" | "unbounded";
  invoke(input: unknown, ctx: Context, request: Invocation): Promise<unknown>;
  jsonSchema?: (() => unknown) | undefined;
}

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
  resolve(workspace: string): Promise<{ path: string; name: string }>;
  call(workspace: string, op: string, input: Json): Promise<unknown>;
}

export interface Resource {
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
}

export interface Extension {
  name: string;
  requires?: string[];
  activate(ctx: Context): void | Promise<void>;
}

export interface Context {
  workspace: string;
  readonly env: {
    readonly lake: Readonly<Record<string, string | undefined>>;
    readonly bl: Readonly<Record<string, string | undefined>>;
  };
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
  registerEvent<S extends z.ZodType, P extends EventPhase>(event: EventDefinition<S, P>): void;
  on<S extends z.ZodType, P extends EventPhase>(
    event: EventDefinition<S, P>,
    handler: EventHandler<z.output<S>, P>,
  ): () => void;
  emit<S extends z.ZodType, P extends EventPhase>(
    event: EventDefinition<S, P>,
    data: z.input<S>,
  ): void;
  bin(name: string, bin: Bin): void;
}
