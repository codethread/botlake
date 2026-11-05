import { Fault, jsonSchema, requireValue } from "@botlake/core";
import {
  isMachineSnapshot,
  type ActorRefFrom,
  type UnknownActorRef,
  type AnyStateMachine,
} from "xstate";
import { z } from "zod";

const text = z.string().min(1);
const commandsSchema = z.record(z.string(), text);
const contextSchema = z.record(z.string(), z.unknown());

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
  /** Context when this visit enters the published frontier. */
  context: Context;
}

export interface TaskEntry extends TaskContext {
  /** Published Work node. */
  bead: string;
  /** Frozen instructions, commands and inert task metadata. */
  meta: ResolvedTask;
}

export interface Metadata {
  /** A titled state publishes Work; untitled states stay inside XState. */
  title: string;
  /** Named choices mapped to native XState events. Omit to publish a group. */
  commands?: Record<string, string> | undefined;
  /** Render instructions and JSON metadata once per published visit. */
  task: (input: TaskContext) => unknown;
  /** Inert author metadata retained in the resolved task. */
  [key: string]: unknown;
}

export const metadataSchema = z.compile(
  z
    .object({
      commands: commandsSchema.optional(),
      task: z.custom<Metadata["task"]>(callable),
      title: text,
    })
    .catchall(z.unknown()),
);

const machineContract = z.object({
  getInitialSnapshot: z.custom(callable),
  getPersistedSnapshot: z.custom(callable),
  restoreSnapshot: z.custom(callable),
  transition: z.custom(callable),
});

export const definitionSchema = z.compile(
  z.object({
    commandSchemas: z.record(z.string(), z.instanceof(z.ZodType)),
    describe: z.custom<(entry: TaskEntry) => Record<string, unknown>>(callable).optional(),
    inputConstraints: z.string().optional(),
    inputSchema: z.instanceof(z.ZodType),
    machine: z.custom<AnyStateMachine>((value) => machineContract.safeParse(value).success),
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
  return resolvedTaskSchema.parse({ ...defaults, ...contextSchema.parse(task({ context })) });
}

export function actorContext(actor: WorkflowActor): Record<string, unknown> {
  return contextSchema.parse(actor.getSnapshot().context as unknown);
}

/** Promise, callback and observable actors are execution, not Work-producing machines. */
export function isWorkflowActor(actor: UnknownActorRef): actor is WorkflowActor {
  return isMachineSnapshot(actor.getSnapshot());
}

export function childActors(actor: WorkflowActor): UnknownActorRef[] {
  // XState erases the concrete child types in AnyStateMachine.
  // oxlint-disable-next-line typescript/no-unsafe-assignment
  const children: Record<string, UnknownActorRef | undefined> = actor.getSnapshot().children;
  return Object.values(children).filter((child) => child !== undefined);
}

export function targetActor(root: WorkflowActor, path: string[]): WorkflowActor {
  return path.reduce((actor, id) => {
    const child = requireValue(
      childActors(actor).find((candidate) => candidate.id === id),
      `Missing workflow child actor ${id} on route ${path.join("/")}`,
    );
    if (!isWorkflowActor(child)) throw new Fault("workflow", `Task actor is not a machine: ${id}`);
    return child;
  }, root);
}

export function invocations(
  actor: WorkflowActor,
  path: string[] = [],
): Array<{
  id: string;
  path: string[];
  status: string;
}> {
  return childActors(actor).flatMap((child) =>
    isWorkflowActor(child)
      ? invocations(child, [...path, child.id])
      : [{ id: child.id, path: [...path, child.id], status: child.getSnapshot().status }],
  );
}

// --- Definition boundary ---

function callable(value: unknown): value is (...args: unknown[]) => unknown {
  return typeof value === "function";
}
