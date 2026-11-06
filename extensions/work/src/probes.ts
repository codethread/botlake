import {
  defineOp,
  Fault,
  jsonSchema,
  q,
  requireValue,
  type Context,
  type Json,
} from "@botlake/core";
import { z } from "zod";

import { gatePolicySchema, workAttributes } from "./node-model.ts";
import { registerGateLifecycle, workStore } from "./store.ts";
import type { Gate, GatePolicy, GateTransition } from "./types.ts";

interface JsonObject {
  [key: string]: Json;
}

export type ProbeVerdict =
  | { outcome: "passed"; message: string; evidence?: JsonObject | undefined }
  | { outcome: "failed"; message: string; evidence?: JsonObject | undefined };

export interface ProbeDefinition<P extends z.ZodType = z.ZodType> {
  /** Stable name stored on gates and resolved by trusted configuration. */
  name: string;
  /** User-facing explanation exposed by `gate probes`. */
  description: string;
  /** Parses parameters before storage and again before evaluation. */
  params: P;
  /** Retry and timeout policy copied to each gate at creation. */
  policy: GatePolicy;
  /** Check the condition; use the signal for cancellable I/O. */
  run(params: z.output<P>, context: { signal: AbortSignal; gate: string }): Promise<ProbeVerdict>;
}

interface GateCreation {
  title: string;
  probe: string;
  params: JsonObject;
  parent?: string;
  dependents?: string[];
  description?: string;
  by: string;
}

/** Synchronous publication after asynchronous trusted probe resolution. */
type PreparedGate = (placement?: { parent?: string; dependents?: string[] }) => Gate;

interface GateService {
  prepare(input: GateCreation): Promise<PreparedGate>;
  create(input: GateCreation): Promise<Gate>;
  retry(id: string, by: string, reason: string): GateTransition;
  clear(id: string, by: string, message: string): GateTransition;
  dismiss(id: string, by: string, reason: string): GateTransition;
}

type ProbeResolver = (key: string) => Promise<ProbeDefinition | undefined>;

interface Instance {
  resolvers: ProbeResolver[];
  service: GateService;
}

interface Evaluation {
  wake: z.infer<typeof wakeSchema>;
  controller: AbortController;
  drained: Promise<void>;
}

const instances = new WeakMap<Context, Instance>();
const text = z.string().trim().min(1);
const verdictSchema = z.strictObject({
  outcome: z.enum(["passed", "failed"]),
  message: text,
  evidence: z.record(z.string(), z.json()).optional(),
});
const wakeSchema = z.strictObject({
  id: text,
  round: z.number().int().positive(),
  attempt: z.number().int().positive(),
});
const gateInput = z.discriminatedUnion("command", [
  z.strictObject({ command: z.literal("probes") }),
  z.strictObject({
    command: z.literal("create"),
    title: text,
    probe: text,
    param: z.array(text).default([]),
    dependent: z.array(text).default([]),
    parent: text.optional(),
    description: z.string().optional(),
  }),
  z.strictObject({ command: z.literal("retry"), id: text, reason: text.default("Retry gate") }),
  z.strictObject({
    command: z.literal("clear"),
    id: text,
    reason: text,
    dismiss: z.boolean().default(false),
  }),
]);

export function defineProbe<P extends z.ZodType>(probe: ProbeDefinition<P>): ProbeDefinition<P> {
  text.parse(probe.name);
  text.parse(probe.description);
  gatePolicySchema.parse(probe.policy);
  return probe;
}

export function registerGateEvaluation(ctx: Context, probes: ProbeDefinition[]): void {
  const configured = new Map(probes.map((probe) => [probe.name, probe]));
  if (configured.size !== probes.length) throw new Fault("work-gate", "Probe names must be unique");

  const resolvers: ProbeResolver[] = [];
  const runner = createRunner(ctx, configured, resolvers);
  const service = createService(ctx, configured, resolvers, runner.changed);
  instances.set(ctx, { resolvers, service });

  ctx.resource(runner);
  ctx.scheduler.register("work/gate-evaluate", async (wake) => {
    await runner.evaluate(wakeSchema.parse(wake.payload));
  });
  registerGateLifecycle(ctx, runner.changed);
  ctx.register(gateOperation(configured, service));

  for (const node of ctx.graph.all({ where: q.eq(q.attr(workAttributes.item), true) })) {
    const item = workStore(ctx).get(node.id);
    if (
      item.kind === "gate" &&
      (item.status.status === "pending" || item.status.status === "waiting")
    )
      runner.changed(item.id);
  }
}

export function gateProbes(ctx: Context): { provide(resolve: ProbeResolver): void } {
  const instance = requireInstance(ctx);
  return {
    provide(resolve) {
      instance.resolvers.push(resolve);
    },
  };
}

export function gateService(ctx: Context): GateService {
  return requireInstance(ctx).service;
}

// --- implementation ---

function createService(
  ctx: Context,
  probes: Map<string, ProbeDefinition>,
  resolvers: ProbeResolver[],
  changed: (id: string) => void,
): GateService {
  const gates = workStore(ctx).gates;
  async function prepare(input: GateCreation): Promise<PreparedGate> {
    const probe = await resolveProbe(input.probe, probes, resolvers);
    if (probe === undefined) throw new Fault("work-gate", `Unknown probe: ${input.probe}`);
    const params = z.record(z.string(), z.json()).parse(probe.params.parse(input.params));
    return (placement = {}) => {
      const gate = gates.create({ ...input, ...placement, params, policy: probe.policy });
      ctx.graph.afterCommit(() => {
        changed(gate.id);
      });
      return gate;
    };
  }
  return {
    prepare,
    async create(input) {
      return (await prepare(input))();
    },
    retry(id, by, reason) {
      return gates.apply(id, { type: "retry", at: now(ctx), by, reason });
    },
    clear(id, by, message) {
      return gates.apply(id, { type: "clear", at: now(ctx), by, message });
    },
    dismiss(id, by, reason) {
      return gates.apply(id, { type: "dismiss", at: now(ctx), by, reason });
    },
  };
}

function gateOperation(probes: Map<string, ProbeDefinition>, service: GateService) {
  return defineOp({
    name: "gate",
    input: gateInput,
    output: jsonSchema,
    jsonSchema: { input: gateInput, output: jsonSchema },
    about: "Create and evaluate Work gates backed by trusted named probes.",
    primer:
      "Use a gate when work is blocked on a machine-checkable condition: `bl gate create TITLE --probe KEY --dependent TASK`. The dependent waits while the gate is open. Pending is due now, waiting has a retry scheduled, and exhausted needs retry, clear or dismissal. Cleared and dismissed are terminal closed outcomes; both satisfy readiness. Status explains evaluation and never affects readiness directly. Probe code is trusted configuration; inspect available probes with `bl gate probes`.",
    cli: {
      description: "Manage machine-checked Work gates",
      commands: {
        probes: { description: "List configured probes, parameter schemas and policies" },
        create: {
          description: "Create a gate after validating its named probe and parameters",
          positionals: [{ name: "title", type: "string", required: true }],
          flags: {
            probe: { type: "string", required: true },
            param: { type: "string", multiple: true },
            dependent: { type: "string", multiple: true },
            parent: { type: "string" },
            description: { type: "string" },
          },
        },
        retry: {
          description: "Start a fresh evaluation round",
          positionals: [{ name: "id", type: "string", required: true }],
          flags: { reason: { type: "string" } },
        },
        clear: {
          description: "Clear or dismiss an open gate",
          positionals: [{ name: "id", type: "string", required: true }],
          flags: {
            reason: { type: "string", required: true },
            dismiss: { type: "boolean" },
          },
        },
      },
    },
    async handler(value, _context, invocation) {
      const by = requireValue(invocation.identity, "Gate commands require caller identity");
      switch (value.command) {
        case "probes":
          return jsonSchema.parse({
            items: [...probes.values()].map((probe) => ({
              name: probe.name,
              description: probe.description,
              params: z.toJSONSchema(probe.params, { io: "input" }),
              policy: probe.policy,
            })),
          });
        case "create":
          return jsonSchema.parse(
            await service.create({
              title: value.title,
              probe: value.probe,
              params: parseParams(value.param),
              dependents: value.dependent,
              ...(value.parent === undefined ? {} : { parent: value.parent }),
              ...(value.description === undefined ? {} : { description: value.description }),
              by,
            }),
          );
        case "retry":
          return jsonSchema.parse(service.retry(value.id, by, value.reason));
        case "clear":
          return jsonSchema.parse(
            value.dismiss
              ? service.dismiss(value.id, by, value.reason)
              : service.clear(value.id, by, value.reason),
          );
      }
    },
  });
}

function createRunner(
  ctx: Context,
  probes: Map<string, ProbeDefinition>,
  resolvers: ProbeResolver[],
) {
  const running = new Map<string, Evaluation>();
  let stopping = false;

  return {
    start() {},
    quiesce() {
      stopping = true;
      for (const evaluation of running.values())
        evaluation.controller.abort(new Fault("cancelled", "Work gate evaluator stopped"));
    },
    async stop() {
      await Promise.all([...running.values()].map(({ drained }) => drained));
    },
    changed(this: void, id: string) {
      if (stopping) return;
      // Multiple transitions in one transaction reconcile against its final authority.
      const gate = workStore(ctx).gates.get(id);
      const expected = expectedAttempt(gate);
      const evaluation = running.get(id);
      if (evaluation !== undefined && !sameAttempt(expected, evaluation.wake))
        evaluation.controller.abort(new Fault("cancelled", "Gate evaluation superseded"));
      cancelGateWakes(ctx, id, expected);
      if (expected !== undefined) schedule(ctx, gate);
    },
    async evaluate(wake: z.infer<typeof wakeSchema>) {
      // Cancellation revokes authority immediately, but the old probe still owns its
      // slot until its actual promise settles (including asynchronous abort cleanup).
      for (;;) {
        const previous = running.get(wake.id);
        if (previous === undefined) break;
        await previous.drained;
      }
      if (stopping || !sameAttempt(expectedAttempt(workStore(ctx).gates.get(wake.id)), wake))
        return;
      const evaluation: Evaluation = {
        wake,
        controller: new AbortController(),
        drained: Promise.resolve(),
      };
      running.set(wake.id, evaluation);
      evaluation.drained = evaluate(ctx, evaluation, probes, resolvers, () => stopping).finally(
        () => {
          running.delete(wake.id);
        },
      );
      await evaluation.drained;
    },
  };
}

async function evaluate(
  ctx: Context,
  evaluation: Evaluation,
  probes: Map<string, ProbeDefinition>,
  resolvers: ProbeResolver[],
  stopping: () => boolean,
): Promise<void> {
  const { wake, controller } = evaluation;
  const gate = workStore(ctx).gates.get(wake.id);
  const at = now(ctx);
  let result: ProbeVerdict | { outcome: "errored"; message: string };
  try {
    const probe = await resolveProbe(gate.probe, probes, resolvers);
    controller.signal.throwIfAborted();
    if (probe === undefined) throw new Error(`Unknown probe: ${gate.probe}`);
    const params = probe.params.parse(gate.params);
    result = await runWithTimeout(ctx, probe, params, gate, controller);
  } catch (error) {
    result = { outcome: "errored", message: readableError(error) };
  }
  // A timeout is an attempt result, but withdrawn authority must never publish.
  if (stopping() || !sameAttempt(expectedAttempt(workStore(ctx).gates.get(gate.id)), wake)) return;
  const attemptResult = result.outcome === "passed" ? result : { ...result, at };
  workStore(ctx).gates.apply(gate.id, {
    type: "attempt",
    round: wake.round,
    attempt: wake.attempt,
    at,
    by: "work",
    result: attemptResult,
  });
}

async function runWithTimeout(
  ctx: Context,
  probe: ProbeDefinition,
  params: unknown,
  gate: Gate,
  controller: AbortController,
): Promise<ProbeVerdict> {
  let timeout: Error | undefined;
  const cancel = ctx.clock.arm(ctx.clock.now() + gate.policy.timeoutMs, () => {
    timeout = new Error(`Probe timed out after ${gate.policy.timeoutMs}ms`);
    controller.abort(timeout);
  });
  try {
    // Do not race away from a live probe: abort is cooperative, and the next
    // evaluation must wait for this promise even if cancellation takes time.
    const verdict = await probe.run(params, { signal: controller.signal, gate: gate.id });
    if (timeout !== undefined) throw timeout;
    return verdictSchema.parse(verdict);
  } catch (error) {
    throw timeout ?? error;
  } finally {
    cancel();
  }
}

function sameAttempt(
  expected: ReturnType<typeof expectedAttempt>,
  wake: z.infer<typeof wakeSchema>,
): boolean {
  return expected?.round === wake.round && expected.attempt === wake.attempt;
}

function schedule(ctx: Context, gate: Gate): void {
  const expected = expectedAttempt(gate);
  if (expected === undefined) return;
  const due = gate.status.status === "waiting" ? Date.parse(gate.status.nextAt) : ctx.clock.now();
  const key = wakeKey(gate.id, expected.round, expected.attempt);
  if (ctx.scheduler.pending().some((wake) => wake.key === key)) return;
  ctx.scheduler.schedule(key, Math.max(ctx.clock.now(), due), "work/gate-evaluate", {
    id: gate.id,
    ...expected,
  });
}

function cancelGateWakes(
  ctx: Context,
  id: string,
  expected: ReturnType<typeof expectedAttempt>,
): void {
  const keep = expected === undefined ? undefined : wakeKey(id, expected.round, expected.attempt);
  for (const wake of ctx.scheduler.pending())
    if (wake.key.startsWith(`gate/${id}/`) && wake.key !== keep) ctx.scheduler.cancel(wake.key);
}

function expectedAttempt(gate: Gate): { round: number; attempt: number } | undefined {
  if (gate.status.status === "pending") return { round: gate.status.round, attempt: 1 };
  if (gate.status.status === "waiting")
    return { round: gate.status.round, attempt: gate.status.attempts + 1 };
  return undefined;
}

async function resolveProbe(
  key: string,
  probes: Map<string, ProbeDefinition>,
  resolvers: ProbeResolver[],
): Promise<ProbeDefinition | undefined> {
  const configured = probes.get(key);
  if (configured !== undefined) return configured;
  for (const resolver of resolvers) {
    const resolved = await resolver(key);
    if (resolved !== undefined) return resolved;
  }
  return undefined;
}

function parseParams(values: string[]): JsonObject {
  const params: JsonObject = {};
  for (const value of values) {
    const separator = value.indexOf("=");
    if (separator <= 0) throw new Fault("work-gate", `Expected parameter K=V: ${value}`);
    const key = value.slice(0, separator);
    const raw = value.slice(separator + 1);
    try {
      params[key] = z.json().parse(JSON.parse(raw));
    } catch {
      params[key] = raw;
    }
  }
  return params;
}

function wakeKey(id: string, round: number, attempt: number): string {
  return `gate/${id}/${round}/${attempt}`;
}

function now(ctx: Context): string {
  return new Date(ctx.clock.now()).toISOString();
}

function readableError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireInstance(ctx: Context): Instance {
  const instance = instances.get(ctx);
  if (instance === undefined) throw new Fault("work-gate", "The Work extension is not selected");
  return instance;
}
