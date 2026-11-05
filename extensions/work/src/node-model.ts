import { z } from "zod";

/** Work node attribute keys. */
export const workAttributes = {
  /** Marks a task or context group. */
  item: "work/item",
  /** Task or context group. */
  kind: "work/kind",
  /** Local brief, inherited by descendants of a group. */
  description: "work/description",
  /** Conclusions, findings and references. Absent until recorded. */
  notes: "work/notes",
  /** Participation mode for a task. */
  audience: "work/audience",
  /** Planned work or an interruption. */
  origin: "work/origin",
  /** Task urgency from P0 through P4. */
  priority: "work/priority",
  /** Trusted probe name for a machine-checked gate. */
  probe: "work/probe",
  /** Probe parameters for a machine-checked gate. */
  params: "work/params",
  /** Retry policy frozen when a gate is created. */
  policy: "work/policy",
  /** Current gate lifecycle status. */
  status: "work/status",
  /** Acceptance conditions and their resolution history. */
  criteria: "work/criteria",
  /** Assignment generations and retained release attribution. */
  assignments: "work/assignments",
  /** Attributed closures in chronological order. */
  closures: "work/closures",
  /** Attributed recoveries in chronological order. */
  reopenings: "work/reopenings",
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
export const jsonObjectSchema = z.record(z.string(), z.json());
export const gatePolicySchema = z.object({
  everyMs: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  timeoutMs: z.number().int().positive(),
});
const evidence = { evidence: jsonObjectSchema.optional() };
export const gateAttemptSchema = z.object({
  at: z.iso.datetime(),
  outcome: z.enum(["failed", "errored"]),
  message: text,
  ...evidence,
});
export const gateStatusSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending"), round: z.number().int().positive() }),
  z.object({
    status: z.literal("waiting"),
    round: z.number().int().positive(),
    attempts: z.number().int().positive(),
    last: gateAttemptSchema,
    nextAt: z.iso.datetime(),
  }),
  z.object({
    status: z.literal("exhausted"),
    round: z.number().int().positive(),
    attempts: z.number().int().positive(),
    last: gateAttemptSchema,
  }),
  z.object({
    status: z.literal("cleared"),
    at: z.iso.datetime(),
    by: text,
    via: z.enum(["probe", "actor"]),
    message: text,
    ...evidence,
  }),
  z.object({ status: z.literal("dismissed"), at: z.iso.datetime(), by: text, reason: text }),
]);

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
    z.object({
      kind: z.literal("gate"),
      ...commonData,
      probe: text,
      params: jsonObjectSchema,
      policy: gatePolicySchema,
      status: gateStatusSchema,
    }),
  ]),
);

export type WorkData = z.infer<typeof workDataSchema>;
export type TaskData = z.infer<typeof taskDataSchema>;
export type StoredCriterion = z.infer<typeof storedCriterionSchema>;
