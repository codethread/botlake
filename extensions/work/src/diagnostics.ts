import { Fault, isFault, q, requireValue, sql, type Context } from "@botlake/core";
import { z } from "zod";

import { gateStatusSchema, workAttributes, workRelations } from "./node-model.ts";
import type { GateStatus } from "./types.ts";

const addressSchema = z.object({ lakeId: z.string(), workspace: z.string(), nodeId: z.string() });
const dependencySchema = z.object({
  lakeId: z.string(),
  workspace: z.string(),
  node: z.object({
    id: z.string(),
    title: z.string(),
    state: z.enum(["open", "closed"]),
    gate: z
      .object({
        probe: z.string(),
        status: gateStatusSchema,
      })
      .nullable(),
  }),
  prerequisites: z.object({
    items: z.array(addressSchema).max(100),
    total: z.number().int().nonnegative(),
    nextOffset: z.number().int().nonnegative().nullable(),
  }),
});
const pageInput = z.object({
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().nonnegative().default(0),
});
export const diagnosticLimitsSchema = z.object({
  maxLakes: z.number().int().min(1).max(100).default(8),
  maxNodes: z.number().int().min(1).max(10000).default(1000),
  maxEdges: z.number().int().min(1).max(100000).default(5000),
});
const countSchema = z.object({ total: z.number().int().nonnegative() });
const idsSchema = z.array(z.object({ id: z.string() }));
const ownerSchema = z.object({ lakeId: z.string(), workspace: z.string() });

export interface WorkAddress {
  /** Stable source database identity. */
  lakeId: string;
  /** Route used to contact that owner. */
  workspace: string;
  /** Work node ID within the owning lake. */
  nodeId: string;
}

export interface ObservedWork extends WorkAddress {
  /** Source title at the time of this diagnostic read. */
  title: string;
  /** Source lifecycle observed during traversal. */
  state: "open" | "closed";
  /** Probe evidence when this observation is a gate. */
  gate: {
    probe: string;
    status: GateStatus;
  } | null;
}

export interface WorkDependencyPage {
  /** Authoritative identity of the responding lake. */
  lakeId: string;
  /** Canonical route of the responding lake. */
  workspace: string;
  /** Source-owned work item; descriptions and histories are omitted. */
  node: {
    id: string;
    title: string;
    state: "open" | "closed";
    gate: {
      probe: string;
      status: GateStatus;
    } | null;
  };
  /** Bounded direct owner addresses; fetch that owner for current work facts. */
  prerequisites: { items: WorkAddress[]; total: number; nextOffset: number | null };
}

export interface WorkDiagnosticOptions {
  /** Maximum distinct owners contacted, including the local lake. */
  maxLakes?: number | undefined;
  /** Maximum distinct prerequisite nodes inspected. */
  maxNodes?: number | undefined;
  /** Maximum dependency edges read, bounding dense graphs as well as node count. */
  maxEdges?: number | undefined;
}

export interface WorkDiagnosis {
  /** Local root whose transitive prerequisites were examined. */
  root: WorkAddress;
  /** False when a bound, unavailable owner or changed identity left unknown branches. */
  complete: boolean;
  /** Contacted owner count, attempted node count and observed edge count. */
  examined: { lakes: number; nodes: number; edges: number };
  /** Recorded cycles may include closed work, so do not establish current blockedness.
   * One path per cyclic component; paths repeat their first node. */
  cycles: { path: ObservedWork[]; members: ObservedWork[] }[];
  /** Owners or work items that could not be read; no absence is inferred. */
  unavailable: { node: WorkAddress; code: string; reason: string }[];
  /** Open machine gates reached while explaining why the root is waiting. */
  blockers: ObservedWork[];
  /** Explicit limits reached; an empty list means no configured bound truncated traversal. */
  limits: ("lakes" | "nodes" | "edges")[];
}

/** Read one owner-local, bounded prerequisite frontier without copying work briefs. */
export function workDependencies(
  ctx: Context,
  id: string,
  options: { limit?: number | undefined; offset?: number | undefined } = {},
): WorkDependencyPage {
  const { limit, offset } = pageInput.parse(options);
  const node = ctx.graph.summaries([id])[0];
  const fullNode = ctx.graph.show(id);
  const owner = { lakeId: ctx.graph.lakeId, workspace: ctx.workspace };
  if (node === undefined) throw new Fault("not-found", `Unknown work item: ${id}`, owner);
  if (
    node.reference !== null ||
    ctx.graph.count({
      where: q.and(q.eq("id", id), q.eq(q.attr(workAttributes.item), true)),
      limit: 1,
    }) === 0
  )
    throw new Fault("work", "Dependency frontiers require a locally owned task or group", owner);
  const { total } = countSchema.parse(
    ctx.graph.db
      .query(sql`
    SELECT COUNT(*) AS total FROM edges WHERE from_id = ? AND relation = ?
  `)
      .get(id, workRelations.dependsOn),
  );
  const ids = idsSchema
    .parse(
      ctx.graph.db
        .query(sql`
    SELECT to_id AS id FROM edges
    WHERE from_id = ? AND relation = ? ORDER BY to_id LIMIT ? OFFSET ?
  `)
        .all(id, workRelations.dependsOn, limit, offset),
    )
    .map((row) => row.id);
  return {
    lakeId: ctx.graph.lakeId,
    workspace: ctx.workspace,
    node: {
      id: node.id,
      title: node.title,
      state: node.state === "closed" ? "closed" : "open",
      gate:
        fullNode.attributes[workAttributes.kind] === "gate"
          ? {
              probe: z.string().parse(fullNode.attributes[workAttributes.probe]),
              status: awaitGateStatus(fullNode.attributes[workAttributes.status]),
            }
          : null,
    },
    prerequisites: {
      items: ctx.graph.summaries(ids).map((endpoint) => ({
        lakeId: endpoint.reference?.lakeId ?? ctx.graph.lakeId,
        workspace: endpoint.reference?.workspace ?? ctx.workspace,
        nodeId: endpoint.reference?.nodeId ?? endpoint.id,
      })),
      total,
      nextOffset: offset + limit < total ? offset + limit : null,
    },
  };
}

/** Inspect live owner frontiers. The observations are not a cross-lake transaction. */
export async function diagnoseWork(
  ctx: Context,
  id: string,
  options: WorkDiagnosticOptions,
  signal: AbortSignal,
): Promise<WorkDiagnosis> {
  const bounds = diagnosticLimitsSchema.parse(options);
  workDependencies(ctx, id, { limit: 1 });
  const root: WorkAddress = { lakeId: ctx.graph.lakeId, workspace: ctx.workspace, nodeId: id };
  const pending: WorkAddress[] = [root];
  const attempted = new Set<string>();
  const owners = new Set<string>();
  const observations = new Map<string, ObservedWork>();
  const edges = new Map<string, Set<string>>();
  const unavailable: WorkDiagnosis["unavailable"] = [];
  const limits = new Set<WorkDiagnosis["limits"][number]>();
  let edgeCount = 0;

  while (pending.length > 0) {
    signal.throwIfAborted();
    const address = requireValue(pending.pop(), "Missing diagnostic frontier");
    const key = identity(address);
    if (attempted.has(key)) continue;
    if (attempted.size === bounds.maxNodes) {
      limits.add("nodes");
      break;
    }
    if (!owners.has(address.lakeId) && owners.size === bounds.maxLakes) {
      limits.add("lakes");
      continue;
    }
    attempted.add(key);
    owners.add(address.lakeId);
    const outgoing = new Set<string>();
    edges.set(key, outgoing);
    try {
      let offset: number | null = 0;
      while (offset !== null) {
        signal.throwIfAborted();
        const remaining = bounds.maxEdges - edgeCount;
        const request: { command: "dependencies"; id: string; limit: number; offset: number } = {
          command: "dependencies",
          id: address.nodeId,
          limit: Math.min(100, Math.max(1, remaining)),
          offset,
        };
        const page: WorkDependencyPage =
          address.lakeId === ctx.graph.lakeId
            ? workDependencies(ctx, address.nodeId, request)
            : dependencySchema.parse(
                await ctx.peers.call(address.workspace, "work", request, {
                  signal,
                  timeoutMs: 5000,
                }),
              );
        if (page.lakeId !== address.lakeId || page.node.id !== address.nodeId)
          throw new Fault(
            "source-mismatch",
            "Source identity changed; this diagnostic did not follow a replacement database",
          );
        if (page.prerequisites.nextOffset !== null && page.prerequisites.nextOffset <= offset)
          throw new Fault("invalid-source", "Source prerequisite pagination did not advance");
        observations.set(key, {
          ...address,
          workspace: page.workspace,
          title: page.node.title,
          state: page.node.state,
          gate: page.node.gate,
        });
        if (page.prerequisites.items.length > remaining) {
          limits.add("edges");
          break;
        }
        for (const target of page.prerequisites.items) {
          const targetKey = identity(target);
          outgoing.add(targetKey);
          pending.push(target);
        }
        edgeCount += page.prerequisites.items.length;
        offset = page.prerequisites.nextOffset;
        if (remaining === 0 && offset !== null) {
          limits.add("edges");
          break;
        }
      }
    } catch (error) {
      signal.throwIfAborted();
      const source = isFault(error) ? ownerSchema.safeParse(error.details) : null;
      const changed = source?.success === true && source.data.lakeId !== address.lakeId;
      unavailable.push({
        node: address,
        code: changed ? "source-mismatch" : isFault(error) ? error.code : "unavailable",
        reason: changed
          ? `Source route now identifies lake ${source.data.lakeId}; expected ${address.lakeId}`
          : error instanceof Error
            ? error.message
            : String(error),
      });
    }
    if (limits.has("edges")) break;
  }
  return {
    root,
    complete: unavailable.length === 0 && limits.size === 0,
    examined: { lakes: owners.size, nodes: attempted.size, edges: edgeCount },
    cycles: findCycles(edges).map(({ path, members }) => ({
      path: path.map((key) => requireValue(observations.get(key), "Missing observed cycle node")),
      members: members.map((key) =>
        requireValue(observations.get(key), "Missing observed component node"),
      ),
    })),
    unavailable,
    blockers: [...observations.values()].filter(
      (observation) => observation.state === "open" && observation.gate !== null,
    ),
    limits: [...limits],
  };
}

function awaitGateStatus(value: unknown): GateStatus {
  return gateStatusSchema.parse(value);
}

// -- Bounded graph analysis --

function identity(address: WorkAddress): string {
  return JSON.stringify([address.lakeId, address.nodeId]);
}

function findCycles(
  edges: ReadonlyMap<string, ReadonlySet<string>>,
): { path: string[]; members: string[] }[] {
  const visited = new Set<string>();
  const order: string[] = [];
  const reverse = new Map<string, Set<string>>();
  for (const [from, targets] of edges) {
    for (const target of targets) {
      const previous = reverse.get(target) ?? new Set<string>();
      previous.add(from);
      reverse.set(target, previous);
    }
    const stack = [{ key: from, exit: false }];
    while (stack.length > 0) {
      const current = requireValue(stack.pop(), "Missing traversal node");
      if (current.exit) {
        order.push(current.key);
        continue;
      }
      if (visited.has(current.key)) continue;
      visited.add(current.key);
      stack.push({ key: current.key, exit: true });
      for (const neighbor of edges.get(current.key) ?? [])
        if (!visited.has(neighbor)) stack.push({ key: neighbor, exit: false });
    }
  }
  visited.clear();
  const cycles: { path: string[]; members: string[] }[] = [];
  for (const key of order.toReversed()) {
    if (visited.has(key)) continue;
    const members: string[] = [];
    const stack = [key];
    while (stack.length > 0) {
      const current = requireValue(stack.pop(), "Missing component node");
      if (visited.has(current)) continue;
      visited.add(current);
      members.push(current);
      for (const neighbor of reverse.get(current) ?? [])
        if (!visited.has(neighbor)) stack.push(neighbor);
    }
    if (members.length > 1 || edges.get(key)?.has(key) === true)
      cycles.push({ path: cyclePath(edges, new Set(members)), members });
  }
  return cycles;
}

function cyclePath(
  edges: ReadonlyMap<string, ReadonlySet<string>>,
  members: ReadonlySet<string>,
): string[] {
  const first = requireValue(members.values().next().value, "Missing cycle member");
  const path: string[] = [first];
  const active = new Map([[first, 0]]);
  const visited = new Set([first]);
  const stack = [
    {
      key: first,
      neighbors: [...(edges.get(first) ?? [])].filter((key) => members.has(key)),
      index: 0,
    },
  ];
  while (stack.length > 0) {
    const frame = requireValue(stack.at(-1), "Missing cycle frontier");
    const neighbor = frame.neighbors[frame.index++];
    if (neighbor === undefined) {
      stack.pop();
      active.delete(frame.key);
      path.pop();
      continue;
    }
    const start = active.get(neighbor);
    if (start !== undefined) return [...path.slice(start), neighbor];
    if (visited.has(neighbor)) continue;
    visited.add(neighbor);
    active.set(neighbor, path.length);
    path.push(neighbor);
    stack.push({
      key: neighbor,
      neighbors: [...(edges.get(neighbor) ?? [])].filter((key) => members.has(key)),
      index: 0,
    });
  }
  throw new Fault("work-diagnostic", "A cyclic component has no cycle path");
}
