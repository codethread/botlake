import type { z } from "zod";

import type { Json } from "../core/json.ts";
import type { NamedQuery } from "../core/query.ts";
import type { Graph, GraphEvent } from "../core/store.ts";
import type { Bin } from "./bins.ts";
import type { Command } from "./cli.ts";
import type { Clock } from "./clock.ts";
import type { factSchema } from "./custody.ts";
import type { EventDefinition, EventFrame, EventHandler, EventPhase } from "./events.ts";
import type { Scheduler } from "./scheduler.ts";

export interface Invocation {
  /** Normalized opaque caller name, or null for an anonymous invocation. */
  identity: string | null;
  signal: AbortSignal;
  requestId: string;
  /** Absolute clock time, or null when only caller cancellation applies. */
  deadline: number | null;
  cwd: string;
  worktreeRoot?: string | undefined;
  gitCommonDir?: string | undefined;
  terminal: { isTTY: boolean; columns: number | null };
  /** CLI presentation preference; terminal facts remain unchanged by --json. */
  output: {
    format: "auto" | "json";
    /** Mark a single-result string for unquoted text transport; still validates normally. */
    text(value: string): string;
  };
}

export interface Op {
  name: string;
  /** Omit for JSON-only peer operations excluded from CLI discovery. */
  cli?: Command | undefined;
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

export interface PeerCallOptions {
  /** Explicit caller identity to forward; omitted calls remain anonymous. */
  identity?: string;
  /** Abort the request and its transport when the caller stops waiting. */
  signal?: AbortSignal;
  /** Relative request deadline in milliseconds; defaults to 30 seconds. */
  timeoutMs?: number;
}

export interface Peers {
  /** Resolve a currently published lake name or canonical workspace path. */
  resolve(workspace: string, options?: PeerCallOptions): Promise<{ path: string; name: string }>;
  /** Invoke one operation at its owner; transport failures are not replayed. */
  call(workspace: string, op: string, input: Json, options?: PeerCallOptions): Promise<unknown>;
  /** Live committed notifications. Wait for ready, then refetch on every reconnect. */
  watch(workspace: string, events: string[], signal: AbortSignal): AsyncIterable<EventFrame>;
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
