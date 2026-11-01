import {
  predicateSchema,
  type Context,
  type Extension,
  type Node,
  type Predicate,
} from "@botlake/core";
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

export interface ReferenceAddress {
  /** Workspace name or route resolved by the owning daemon. */
  workspace: string;
  /** Authoritative node ID in that workspace. */
  nodeId: string;
}

export interface ReferencePageOptions {
  /** Restrict results to this durable owner. */
  lakeId?: string;
  /** Page size, 1–100; default 20. */
  limit?: number;
  /** Continue at the previous result's nextOffset; default 0. */
  offset?: number;
}

export interface References {
  /** Observe a source under a live subscription; optional kinds are checked before import. */
  follow(
    source: ReferenceAddress,
    signal: AbortSignal,
    options?: { kinds: readonly string[] },
  ): Promise<Node>;
  /** Find an existing local handle by route and source ID without reading the source. */
  lookup(source: ReferenceAddress, signal: AbortSignal): Promise<Node | null>;
  /** Refresh an exact local handle; a forgotten handle cannot be adopted again. */
  refresh(id: string, signal: AbortSignal): Promise<Node>;
  /** Remove only the local import and its incident edges. */
  forget(id: string): void;
  /** Paged local summaries; source payloads stay remote. */
  list(options?: ReferencePageOptions): ReferencePage;
  /** Paged connectivity and failure information for selected owners. */
  status(options?: ReferencePageOptions): ReferenceStatusPage;
}

export interface ReferenceLibrary extends Extension {
  /** Obtain this explicitly selected library's instance for the consuming lake. */
  get(ctx: Context): References;
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
export const pageOptionsSchema = z.strictObject({ lakeId: z.uuid().optional(), ...page });
export const inputSchema = z.discriminatedUnion("command", [
  z.strictObject({ command: z.literal("source") }),
  z.strictObject({ command: z.literal("snapshot"), ids: z.array(z.string().min(1)).max(100) }),
]);
export const outputSchema = z.union([sourceSchema, snapshotSchema]);

export interface ReferencePage {
  /** Observed local summaries in this page. */
  nodes: z.output<typeof summarySchema>[];
  /** Total matching entries, including other pages. */
  total: number;
  /** Continuation offset; null means exhausted. */
  nextOffset: number | null;
}

export interface ReferenceStatusPage {
  /** Selected owners in this page. */
  sources: z.output<typeof sourceStatusSchema>[];
  /** Total matching entries, including other pages. */
  total: number;
  /** Continuation offset; null means exhausted. */
  nextOffset: number | null;
}
