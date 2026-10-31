import { Fault, jsonSchema, requireValue, type Json } from "@botlake/core";
import type { ActorRefFrom, AnyStateMachine, Snapshot } from "xstate";
import { createActor } from "xstate";
import { z } from "zod";

const NONEMPTY = 1;
const text = z.string().min(NONEMPTY);
const commandsSchema = z.record(z.string(), text);
const commandSchemasSchema = z.record(z.string(), z.instanceof(z.ZodType));
const contextSchema = z.compile(z.record(z.string(), z.unknown()));

export const resolvedTaskSchema = z.compile(
  z
    .object({
      acceptanceCriteria: z.array(text).optional(),
      notes: z.string().optional(),
      assignee: text.optional(),
      audience: z.enum(["AFK", "HITL"]).optional(),
      commands: commandsSchema.optional(),
      instructions: z.string(),
      origin: z.enum(["planned", "unplanned"]).optional(),
      priority: z.enum(["P0", "P1", "P2", "P3", "P4"]).optional(),
      title: text,
    })
    .catchall(jsonSchema),
);

export type ResolvedTask = z.infer<typeof resolvedTaskSchema>;

export interface TaskContext<Context = Record<string, unknown>> {
  /** Context when this task visit enters the published frontier. */
  context: Context;
}

export interface TaskEntry extends TaskContext {
  /** Published graph work node. */
  bead: string;
  /** Frozen instructions, commands and inert task metadata. */
  meta: ResolvedTask;
}

export interface Metadata {
  /** Titled states project into graph work nodes. */
  title: string;
  /** Named choices mapped to XState events. */
  commands?: Record<string, string> | undefined;
  /** Render instructions and JSON metadata once per published visit. */
  task: (input: TaskContext) => unknown;
  /** Inert author metadata retained in the resolved task. */
  [key: string]: unknown;
}

// Adapted from Busy Bee's dynamic definition seam.
export const metadataSchema = z.compile(
  z
    .object({
      commands: commandsSchema.optional(),
      task: z.custom<Metadata["task"]>(callable),
      title: text,
    })
    .catchall(z.unknown()),
);

const machineContract = z.compile(
  z.object({
    getInitialSnapshot: z.custom(callable),
    getPersistedSnapshot: z.custom(callable),
    restoreSnapshot: z.custom(callable),
    transition: z.custom(callable),
  }),
);

export const definitionSchema = z.compile(
  z.object({
    commandSchemas: commandSchemasSchema,
    describe: z.custom<(entry: TaskEntry) => Record<string, unknown>>(callable).optional(),
    inputConstraints: z.string().optional(),
    inputSchema: z.instanceof(z.ZodType),
    resumeSchema: z.instanceof(z.ZodType).optional(),
    machine: z.custom<AnyStateMachine>(machineLike),
    runBrief: z.custom<(input: unknown) => unknown>(callable),
    validateCommand: z
      .custom<(entry: TaskEntry, command: string, data: unknown) => void>(callable)
      .optional(),
  }),
);

export type Definition = z.infer<typeof definitionSchema>;
export type WorkflowActor = ActorRefFrom<AnyStateMachine>;
export type WorkflowNode = AnyStateMachine["root"];

export function renderTask(metadata: Metadata, context: Record<string, unknown>): ResolvedTask {
  const { task, ...defaults } = metadata;
  const rendered = task({ context });
  return resolvedTaskSchema.parse({ ...defaults, ...renderedObject(rendered) });
}

export function actorFor(
  definition: Definition,
  state: { input: unknown } | { snapshot: Snapshot<unknown> },
): WorkflowActor {
  const actor = createActor(definition.machine, state);
  actor.subscribe({ error: () => {} });
  return actor;
}

export function initialActor(definition: Definition, input: unknown): WorkflowActor {
  const actor = actorFor(definition, { input });
  actor.start();
  const current = actor.getSnapshot();
  if (current.status === "error") {
    actor.stop();
    throw actorFault(current.error);
  }
  return actor;
}

export function restoredActor(definition: Definition, snapshot: Snapshot<unknown>): WorkflowActor {
  const actor = actorFor(definition, { snapshot });
  actor.start();
  return actor;
}

export function actorContext(actor: WorkflowActor): Record<string, unknown> {
  return contextSchema.parse(actor.getSnapshot().context as unknown);
}

export function childActors(actor: WorkflowActor): WorkflowActor[] {
  // XState's generic children also admits non-machine actor refs; workflow definitions spawn machines.
  // oxlint-disable-next-line typescript/no-unsafe-argument, typescript/no-unsafe-type-assertion
  return Object.values(actor.getSnapshot().children).filter(
    (child) => child !== undefined,
  ) as WorkflowActor[];
}

export function targetActor(root: WorkflowActor, path: string[]): WorkflowActor {
  return path.reduce(
    (actor, id) =>
      requireValue(
        childActors(actor).find((child) => child.id === id),
        `Missing workflow child actor ${id} on route ${path.join("/")}`,
      ),
    root,
  );
}

export function snapshotFor(actor: WorkflowActor): Snapshot<unknown> {
  return actor.getPersistedSnapshot();
}

export function currentStatus(actor: WorkflowActor): string {
  return actor.getSnapshot().status;
}

// --- Private helpers ---

function callable(value: unknown): value is (...args: unknown[]) => unknown {
  return typeof value === "function";
}

function machineLike(value: unknown): value is AnyStateMachine {
  return machineContract.safeParse(value).success;
}

function renderedObject(value: unknown): Record<string, unknown> {
  return z.record(z.string(), z.unknown()).parse(value);
}

function actorFault(error: unknown): Fault {
  return new Fault("workflow", "Workflow actor entered an error state", faultDetails(error));
}

function faultDetails(error: unknown): Json {
  if (error instanceof Error) return { message: error.message, name: error.name };
  const parsed = jsonSchema.safeParse(error);
  return parsed.success ? parsed.data : null;
}
