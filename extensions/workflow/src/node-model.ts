import { jsonSchema } from "@botlake/core";
import type { Snapshot } from "xstate";
import { z } from "zod";

/** Workflow node attribute keys. */
export const workflowAttributes = {
  /** Marks the run's execution checkpoint node. */
  root: "workflow/root",
  /** Marks execution internals as private graph data. */
  private: "workflow/private",
  /** Work group that carries the run's context. */
  contextGroup: "workflow/context-group",
  /** Serialized locator used to restore the authored definition. */
  definition: "workflow/definition",
  /** Serialized XState snapshot for resumption. */
  snapshot: "workflow/snapshot",
  /** Identity that last checkpointed the run. */
  checkpointBy: "workflow/checkpoint-by",
  /** Marks a published state or child actor visit. */
  visit: "workflow/visit",
  /** Marks a visit that publishes an actionable Work task. */
  task: "workflow/task",
  /** Marks a commandless visit that publishes a context group. */
  group: "workflow/group",
  /** Full XState state node identifier for this visit. */
  state: "workflow/state",
  /** Stable actor path and state node identity. */
  key: "workflow/key",
  /** Child actor route from the root actor. */
  path: "workflow/path",
  /** Visit sequence for repeat publications of one key. */
  number: "workflow/number",
  /** Publication order within the run. */
  order: "workflow/order",
  /** Serialized task-facing context at publication. */
  context: "workflow/context",
  /** Serialized resolved task metadata. */
  meta: "workflow/meta",
  /** Marks a visit whose authored action was submitted. */
  consumed: "workflow/consumed",
  /** Serialized original choice and payload. */
  result: "workflow/result",
  /** Completion sequence within the run. */
  completionOrder: "workflow/completion-order",
  /** Identity that completed the visit. */
  completedBy: "workflow/completed-by",
} as const;

/** Private workflow edge labels. */
export const workflowRelations = {
  /** Every visit published by the run. */
  member: "workflow-member",
  /** Visits currently awaiting or offering authored actions. */
  active: "workflow-active",
} as const;

/** Attribute namespace matched by Workflow protection guards. */
export const workflowNamespace = "workflow/" as const;

/** Edge relation namespace matched by Workflow protection guards. */
export const workflowRelationNamespace = "workflow-" as const;

export const semanticVersion =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const text = z.string().min(1);

export const workflowLocatorSchema = z.compile(
  z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("named"),
      name: text,
      version: z.string().trim().regex(semanticVersion, "Expected a full semantic version"),
      hash: text,
    }),
    z.strictObject({ kind: z.literal("file"), source: text, hash: text }),
  ]),
);

export const workflowResultSchema = z.object({ choice: text, data: jsonSchema });

export const workflowSnapshotSchema = z.custom<Snapshot<unknown>>(
  (value) =>
    z
      .object({
        status: z.string(),
        value: jsonSchema,
        context: jsonSchema,
        children: z.record(z.string(), jsonSchema),
      })
      .safeParse(value).success,
);

export type Locator = z.infer<typeof workflowLocatorSchema>;
