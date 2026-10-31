import { z } from "zod";

import { Fault, jsonSchema } from "../core/json.ts";
import type { Graph } from "../core/store.ts";
import type { Clock } from "./clock.ts";
import { defineOp } from "./ops.ts";

export type EventPhase = "transactional" | "afterCommit";

/** An inert, typed event handle. Its owner registers it during extension activation. */
export interface EventDefinition<
  S extends z.ZodType = z.ZodType,
  P extends EventPhase = EventPhase,
> {
  name: string;
  phase: P;
  schema: S;
}

export type EventHandler<T, P extends EventPhase> = P extends "transactional"
  ? (data: T) => undefined
  : (data: T) => void | Promise<void>;

/** Declare a payload contract without registering listeners or activating an extension. */
export function defineEvent<S extends z.ZodType, P extends EventPhase>(
  definition: EventDefinition<S, P>,
): EventDefinition<S, P> {
  return definition;
}

const inputSchema = z.discriminatedUnion("command", [
  z.strictObject({ command: z.literal("list") }),
  z.strictObject({ command: z.literal("stream"), events: z.array(z.string()).default([]) }),
]);
const frameSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("ready"), events: z.array(z.string()) }),
  z.strictObject({
    type: z.literal("event"),
    event: z.string(),
    at: z.number(),
    data: jsonSchema,
  }),
]);
type Frame = z.infer<typeof frameSchema>;
interface Registration {
  definition: EventDefinition;
  handlers: Set<(data: unknown) => unknown>;
}
interface Watcher {
  names: Set<string>;
  push(frame: Frame): void;
  close(): void;
}

/** Lake-local delivery and a bounded, live-only projection onto the existing stream transport. */
export class Events {
  private readonly registrations = new Map<string, Registration>();
  private readonly watchers = new Set<Watcher>();

  constructor(
    private readonly graph: Graph,
    private readonly clock: Clock,
    private readonly report: (error: unknown) => void,
    private readonly enqueue: (action: () => Promise<void>) => void,
  ) {}

  register<S extends z.ZodType, P extends EventPhase>(event: EventDefinition<S, P>): void {
    if (this.registrations.has(event.name))
      throw new Fault("collision", `Duplicate event: ${event.name}`);
    this.registrations.set(event.name, { definition: event, handlers: new Set() });
  }

  on<S extends z.ZodType, P extends EventPhase>(
    event: EventDefinition<S, P>,
    handler: EventHandler<z.output<S>, P>,
  ): () => void {
    const registration = this.registration(event);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- This handle's schema parses every payload before its registered listeners receive it.
    const listener = (data: unknown) => handler(data as z.output<S>);
    registration.handlers.add(listener);
    return () => {
      registration.handlers.delete(listener);
    };
  }

  emit<S extends z.ZodType, P extends EventPhase>(
    event: EventDefinition<S, P>,
    data: z.input<S>,
  ): void {
    const registration = this.registration(event);
    if (event.phase === "transactional" && !this.graph.inTransaction)
      throw new Fault("event", `Transactional event requires graph.atomic: ${event.name}`);
    // This is the publication boundary: parse once and retain a payload snapshot.
    const payload: unknown = event.schema.parse(data);
    if (event.phase === "transactional") {
      for (const handler of registration.handlers) {
        const result = handler(structuredClone(payload));
        if (result instanceof Promise) {
          void result.catch(this.report);
          throw new Fault("event", `Transactional handler must be synchronous: ${event.name}`);
        }
      }
      return;
    }
    const frame = frameSchema.parse({
      type: "event",
      event: event.name,
      at: this.clock.now(),
      data: payload,
    });
    this.graph.afterCommit(() => {
      this.enqueue(async () => {
        for (const watcher of this.watchers) if (watcher.names.has(event.name)) watcher.push(frame);
        for (const handler of registration.handlers) {
          try {
            const result = handler(structuredClone(payload));
            if (result instanceof Promise) await result;
          } catch (error) {
            this.report(error);
          }
        }
      });
    });
  }

  operations() {
    return defineOp({
      name: "events",
      input: inputSchema,
      output: jsonSchema,
      jsonSchema: { input: inputSchema, output: jsonSchema },
      primer:
        "List registered event contracts. Stream committed notifications with events stream, optionally --event NAME repeated. Wait for ready before reading an initial snapshot. Notifications invalidate cached reads; refetch on reconnect. Live only: no replay or durable cursor. A slow consumer is disconnected. Transactional hooks are in-process only.",
      cli: {
        description: "Registered event contracts and live committed notifications",
        commands: {
          list: { description: "List event names, phases and payload schemas" },
          stream: {
            description: "Stream committed notifications as JSONL",
            flags: {
              event: { key: "events", type: "string", multiple: true, description: "Event name" },
            },
          },
        },
      },
      deadline: "unbounded",
      stream: true,
      handler: (input, _ctx, request) => {
        if (input.command === "list") return this.list();
        return this.stream(input.events, request.signal);
      },
    });
  }

  close(): void {
    for (const watcher of this.watchers) watcher.close();
    this.watchers.clear();
    this.registrations.clear();
  }

  // -- Private helpers --

  private registration(event: EventDefinition): Registration {
    const registration = this.registrations.get(event.name);
    if (registration?.definition !== event)
      throw new Fault("event", `Event handle is not registered in this lake: ${event.name}`);
    return registration;
  }

  private list() {
    return [...this.registrations.values()].map(({ definition }) => ({
      name: definition.name,
      phase: definition.phase,
      schema: jsonSchema.parse(z.toJSONSchema(definition.schema, { io: "output" })),
    }));
  }

  private async *stream(names: string[], signal: AbortSignal): AsyncGenerator<Frame> {
    const selected =
      names.length > 0
        ? [...new Set(names)]
        : this.list()
            .filter((event) => event.phase === "afterCommit")
            .map((event) => event.name);
    for (const name of selected)
      if (this.registrations.get(name)?.definition.phase !== "afterCommit")
        throw new Fault("event", `Expected a registered after-commit event: ${name}`);
    const queue: Frame[] = [];
    let wake: (() => void) | undefined;
    let closed = false;
    let failure: Fault | undefined;
    const wait = () =>
      new Promise<void>((resolve) => {
        wake = resolve;
      });
    const close = () => {
      closed = true;
      wake?.();
    };
    const watcher: Watcher = {
      names: new Set(selected),
      close,
      push: (frame) => {
        if (closed) return;
        if (queue.length === 256) {
          queue.length = 0;
          failure = new Fault(
            "event-overflow",
            "Event consumer fell behind; reconnect and refetch",
          );
          close();
          return;
        }
        queue.push(structuredClone(frame));
        wake?.();
      },
    };
    signal.throwIfAborted();
    this.watchers.add(watcher);
    signal.addEventListener("abort", close, { once: true });
    try {
      yield { type: "ready", events: selected };
      for (;;) {
        if (closed) break;
        const next = queue.shift();
        if (next !== undefined) yield next;
        else await wait();
      }
      signal.throwIfAborted();
      if (failure !== undefined) throw failure;
    } finally {
      this.watchers.delete(watcher);
      signal.removeEventListener("abort", close);
    }
  }
}
