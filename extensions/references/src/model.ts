import { predicateSchema, type Predicate } from "@botlake/core";
import { z } from "zod";

export const changedSchema = z.strictObject({ ids: z.array(z.string()) });
export const optionsSchema = z.strictObject({
  projections: z
    .array(z.strictObject({ kind: z.string().min(1), where: predicateSchema }))
    .default([]),
  reconnectMs: z.number().int().positive().max(60_000).default(500),
  requestTimeoutMs: z.number().int().positive().max(60_000).default(5000),
});

export interface ReferenceProjection {
  /** Domain-owned classification of source records. */
  kind: string;
  /** Inert source predicate; never copied into an imported node's attributes. */
  where: Predicate;
}

export interface ReferenceOptions {
  /** Explicitly selected domain projections; none are inferred or activated. */
  projections?: ReferenceProjection[];
  /** Retry delay after source disconnection, in milliseconds; default 500. */
  reconnectMs?: number;
  /** Deadline for one source read, in milliseconds; default 5000. */
  requestTimeoutMs?: number;
}

export const referenceSchema = z.strictObject({
  lakeId: z.uuid(),
  workspace: z.string(),
  nodeId: z.string(),
  revision: z.number().int().positive(),
  observedAt: z.number(),
  status: z.enum(["current", "stale", "missing"]),
  kind: z.string().nullable(),
});
export const summarySchema = z.strictObject({
  id: z.string(),
  title: z.string(),
  state: z.enum(["active", "closed", "replaced"]),
  reference: referenceSchema,
});
export const acknowledgementSchema = summarySchema.omit({ title: true });
export const snapshotSchema = z.strictObject({
  lakeId: z.uuid(),
  nodes: z
    .array(
      z.strictObject({
        id: z.string(),
        title: z.string(),
        state: z.enum(["active", "closed", "replaced"]),
        revision: z.number().int().positive(),
        kind: z.string().nullable(),
      }),
    )
    .max(100),
  missing: z.array(z.string()).max(100),
});
export const sourceSchema = z.strictObject({
  lakeId: z.uuid(),
  workspace: z.string(),
  projections: z.array(z.string()),
});
export const sourceStatusSchema = z.strictObject({
  lakeId: z.uuid(),
  workspace: z.string(),
  state: z.enum(["connecting", "live", "offline"]),
  references: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  error: z.strictObject({ code: z.string(), message: z.string() }).nullable(),
});
const page = {
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().nonnegative().default(0),
};
export const inputSchema = z.discriminatedUnion("command", [
  z.strictObject({
    command: z.literal("add"),
    workspace: z.string().min(1),
    node: z.string().min(1),
  }),
  z.strictObject({ command: z.literal("refresh"), id: z.string().min(1) }),
  z.strictObject({ command: z.literal("forget"), id: z.string().min(1) }),
  z.strictObject({ command: z.literal("list"), lakeId: z.uuid().optional(), ...page }),
  z.strictObject({ command: z.literal("status"), lakeId: z.uuid().optional(), ...page }),
  z.strictObject({ command: z.literal("source") }),
  z.strictObject({ command: z.literal("snapshot"), ids: z.array(z.string().min(1)).max(100) }),
]);
export const outputSchema = z.union([
  acknowledgementSchema,
  z.strictObject({ id: z.string(), forgotten: z.literal(true) }),
  z.strictObject({
    nodes: z.array(summarySchema),
    total: z.number(),
    nextOffset: z.number().nullable(),
  }),
  z.strictObject({
    sources: z.array(sourceStatusSchema),
    total: z.number(),
    nextOffset: z.number().nullable(),
  }),
  sourceSchema,
  snapshotSchema,
]);
