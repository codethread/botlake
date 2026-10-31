import { z } from "zod";

/** Work node attribute keys. */
export const workAttributes = {
  /** Marks a task or context group. */
  item: "work/item",
  /** Serialized task or group storage document. */
  data: "work/data",
} as const;

/** Work relationship labels. */
export const workRelations = {
  /** Contextual containment from group to member. */
  parentOf: "parent-of",
  /** Direct prerequisite from dependent to blocker. */
  dependsOn: "depends-on",
  /** Non-contextual connection retained for reference. */
  references: "references",
} as const;

/** Attribute namespace matched by Work protection guards. */
export const workNamespace = "work/" as const;

/** Link relations accepted by Work operations. */
export type WorkLinkRelation = typeof workRelations.dependsOn | typeof workRelations.references;

export const text = z.string().trim().min(1);
const byAt = { by: text, at: z.iso.datetime() };
const criterionChangeSchema = z.object({
  ...byAt,
  kind: z.enum(["resolved", "reopened"]),
  text,
});
export const storedCriterionSchema = z.object({
  id: text,
  condition: text,
  ...byAt,
  changes: z.array(criterionChangeSchema),
});
export const assignmentSchema = z.object({
  id: text,
  assignee: text,
  ...byAt,
  release: z.object({ ...byAt, reason: text }).nullable(),
});
const commonData = {
  description: z.string(),
  closures: z.array(z.object(byAt)),
  reopenings: z.array(z.object({ ...byAt, reason: text })),
};
export const taskDataSchema = z.object({
  kind: z.literal("task"),
  ...commonData,
  notes: z.string().nullable(),
  audience: z.enum(["AFK", "HITL"]),
  origin: z.enum(["planned", "unplanned"]),
  priority: z.enum(["P0", "P1", "P2", "P3", "P4"]),
  criteria: z.array(storedCriterionSchema),
  assignments: z.array(assignmentSchema),
});
export const workDataSchema = z.compile(
  z.discriminatedUnion("kind", [
    taskDataSchema,
    z.object({ kind: z.literal("group"), ...commonData }),
  ]),
);

export type WorkData = z.infer<typeof workDataSchema>;
export type TaskData = z.infer<typeof taskDataSchema>;
export type StoredCriterion = z.infer<typeof storedCriterionSchema>;
