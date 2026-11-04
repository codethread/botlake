import {
  defineOp,
  Fault,
  jsonSchema,
  q,
  requireValue,
  type Context,
  type Extension,
  type Json,
} from "@botlake/core";
import {
  workAttributes,
  workGateChanged,
  workStore,
  type Gate,
  type GatePolicy,
  type WorkStore,
} from "@botlake/extension-work";
import { match } from "ts-pattern";
import { z } from "zod";

interface JsonObject {
  [key: string]: Json;
}

export type ProbeVerdict =
  | { outcome: "passed"; message: string; evidence?: JsonObject | undefined }
  | { outcome: "failed"; message: string; evidence?: JsonObject | undefined };

export interface ProbeDefinition<P extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  params: P;
  policy: GatePolicy;
  run(params: z.output<P>, context: { signal: AbortSignal; gate: string }): Promise<ProbeVerdict>;
}

type GateTransition = ReturnType<WorkStore["gates"]["apply"]>;

interface GateService {
  create(input: {
    title: string;
    probe: string;
    params: JsonObject;
    parent?: string;
    dependents?: string[];
    description?: string;
    by: string;
  }): Promise<Gate>;
  retry(id: string, by: string, reason: string): GateTransition;
  clear(id: string, by: string, message: string): GateTransition;
  dismiss(id: string, by: string, reason: string): GateTransition;
}

type ProbeResolver = (key: string) => Promise<ProbeDefinition | undefined>;

interface Instance {
  probes: Map<string, ProbeDefinition>;
  resolvers: ProbeResolver[];
  service: GateService;
}

const instances = new WeakMap<Context, Instance>();
const text = z.string().trim().min(1);
const policySchema = z.strictObject({
  everyMs: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  timeoutMs: z.number().int().positive(),
});
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
  policySchema.parse(probe.policy);
  return probe;
}

export function workGates(config: { probes?: ProbeDefinition[] } = {}): Extension {
  const configured = new Map((config.probes ?? []).map((probe) => [probe.name, probe]));
  if (configured.size !== (config.probes ?? []).length)
    throw new Fault("work-gates", "Probe names must be unique");

  return {
    name: "work-gates",
    source: import.meta.url,
    requires: ["work", "identity"],
    activate(ctx) {
      const resolvers: ProbeResolver[] = [];
      const service = createService(ctx, configured, resolvers);
      instances.set(ctx, { probes: configured, resolvers, service });

      ctx.scheduler.register("work-gates/evaluate", async (wake) => {
        await evaluate(ctx, wakeSchema.parse(wake.payload), configured, resolvers);
      });
      ctx.on(workGateChanged, ({ id, to }) => {
        match(to)
          .with({ status: "pending" }, () => {
            schedule(ctx, workStore(ctx).gates.get(id));
          })
          .with({ status: "waiting" }, () => {
            schedule(ctx, workStore(ctx).gates.get(id));
          })
          .with({ status: "exhausted" }, () => {
            cancelGateWakes(ctx, id);
          })
          .with({ status: "cleared" }, () => {
            cancelGateWakes(ctx, id);
          })
          .with({ status: "dismissed" }, () => {
            cancelGateWakes(ctx, id);
          })
          .exhaustive();
      });
      ctx.register(gateOperation(configured, service));

      for (const node of ctx.graph.all({ where: q.eq(q.attr(workAttributes.item), true) })) {
        const item = workStore(ctx).get(node.id);
        if (
          item.kind === "gate" &&
          (item.status.status === "pending" || item.status.status === "waiting")
        )
          schedule(ctx, item);
      }
    },
  };
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
): GateService {
  const gates = workStore(ctx).gates;
  return {
    async create(input) {
      const probe = await resolveProbe(input.probe, probes, resolvers);
      if (probe === undefined) throw new Fault("work-gates", `Unknown probe: ${input.probe}`);
      const params = z.record(z.string(), z.json()).parse(probe.params.parse(input.params));
      const gate = gates.create({ ...input, params, policy: probe.policy });
      schedule(ctx, gate);
      return gate;
    },
    retry(id, by, reason) {
      const transition = gates.apply(id, { type: "retry", at: now(ctx), by, reason });
      if (transition.kind === "moved") schedule(ctx, gates.get(id));
      return transition;
    },
    clear(id, by, message) {
      const transition = gates.apply(id, { type: "clear", at: now(ctx), by, message });
      if (transition.kind === "moved") cancelGateWakes(ctx, id);
      return transition;
    },
    dismiss(id, by, reason) {
      const transition = gates.apply(id, { type: "dismiss", at: now(ctx), by, reason });
      if (transition.kind === "moved") cancelGateWakes(ctx, id);
      return transition;
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

async function evaluate(
  ctx: Context,
  wake: z.infer<typeof wakeSchema>,
  probes: Map<string, ProbeDefinition>,
  resolvers: ProbeResolver[],
): Promise<void> {
  const gate = workStore(ctx).gates.get(wake.id);
  const expected = expectedAttempt(gate);
  if (expected === undefined || expected.round !== wake.round || expected.attempt !== wake.attempt)
    return;

  const at = now(ctx);
  let result: ProbeVerdict | { outcome: "errored"; message: string };
  try {
    const probe = await resolveProbe(gate.probe, probes, resolvers);
    if (probe === undefined) throw new Error(`Unknown probe: ${gate.probe}`);
    const params = probe.params.parse(gate.params);
    result = await runWithTimeout(probe, params, gate.id, gate.policy.timeoutMs);
  } catch (error) {
    result = { outcome: "errored", message: readableError(error) };
  }
  const attemptResult = result.outcome === "passed" ? result : { ...result, at };
  workStore(ctx).gates.apply(gate.id, {
    type: "attempt",
    round: wake.round,
    attempt: wake.attempt,
    at,
    by: "work-gates",
    result: attemptResult,
  });
}

async function runWithTimeout(
  probe: ProbeDefinition,
  params: unknown,
  gate: string,
  timeoutMs: number,
): Promise<ProbeVerdict> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`Probe timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return verdictSchema.parse(
      await Promise.race([probe.run(params, { signal: controller.signal, gate }), timeout]),
    );
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function schedule(ctx: Context, gate: Gate): void {
  const expected = expectedAttempt(gate);
  if (expected === undefined) return;
  const due = gate.status.status === "waiting" ? Date.parse(gate.status.nextAt) : ctx.clock.now();
  ctx.scheduler.schedule(
    wakeKey(gate.id, expected.round, expected.attempt),
    Math.max(ctx.clock.now(), due),
    "work-gates/evaluate",
    { id: gate.id, ...expected },
  );
}

function cancelGateWakes(ctx: Context, id: string): void {
  for (const wake of ctx.scheduler.pending())
    if (wake.key.startsWith(`gate/${id}/`)) ctx.scheduler.cancel(wake.key);
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
    if (separator <= 0) throw new Fault("work-gates", `Expected parameter K=V: ${value}`);
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
  if (instance === undefined)
    throw new Fault("work-gates", "The work-gates extension is not selected");
  return instance;
}

export default workGates();
