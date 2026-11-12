import {
  jsonSchema,
  Fault,
  requireValue,
  defineOp,
  q,
  type Attributes,
  type Graph,
  type Node,
  type Context,
  type Extension,
} from "@botlake/core";
import {
  activitySchema,
  agentMetadata,
  agentMetadataSchema,
  identityInstruction,
  observedActivity,
  sessionIdentity,
  sessionSchema,
  type NativeObservation,
} from "@botlake/native-session";
import { match } from "ts-pattern";
import { z } from "zod";

import { identityAttributes, identityRelations, type AttributionRelation } from "./node-model.ts";

export { identityAttributes, identityRelations } from "./node-model.ts";
export type { AttributionRelation } from "./node-model.ts";

const authority = Symbol("identity");

const text = z.compile(z.string().trim().min(1));

export const startupSchema = z.compile(
  sessionSchema.extend({
    parentNativeSessionId: text.optional(),
    ...agentMetadataSchema.shape,
  }),
);

export type Startup = z.infer<typeof startupSchema>;

export function identityRecords(graph: Graph): Node[] {
  return graph.all({
    where: q.eq(q.attr(identityAttributes.session), true),
    includeArchived: true,
  });
}

export function resolveIdentity(graph: Graph, name: string): Node | undefined {
  return graph.all({ where: q.eq(q.attr(identityAttributes.id), name), includeArchived: true })[0];
}

export function attribution(graph: Graph, name: string): { identity: string; nodeIds: string[] } {
  const record = resolveIdentity(graph, name);

  return { identity: name, nodeIds: record === undefined ? [] : [record.id] };
}

export function attribute(
  ctx: Context,
  target: string,
  name: string,
  relation: AttributionRelation,
): void {
  const resolved = resolveIdentity(ctx.graph, name);

  if (resolved !== undefined) ctx.graph.connect(resolved.id, target, relation);
}

export function nativeStartup(
  ctx: Context,
  input: Startup,
): {
  identity: string;
  nodeId: string;
  result: "created" | "recovered";
  instruction: string;
} {
  return ctx.graph.atomic(() => {
    const identityId = sessionIdentity(input);
    let record = resolveIdentity(ctx.graph, identityId);
    if (
      record !== undefined &&
      (record.attributes[identityAttributes.provider] !== input.provider ||
        record.attributes[identityAttributes.nativeSessionId] !== input.nativeSessionId)
    )
      throw new Fault("identity", `Native identity name collision: ${identityId}`);
    const result = record === undefined ? "created" : "recovered";

    record ??= ctx.graph.add({
      title: `${input.provider} ${input.nativeSessionId}`,
      attributes: {
        [identityAttributes.session]: true,
        [identityAttributes.id]: identityId,
        [identityAttributes.provider]: input.provider,
        [identityAttributes.nativeSessionId]: input.nativeSessionId,
        [identityAttributes.activity]: "unknown",
      },
    });

    const patch: Attributes = {};
    if (input.agentSeat !== undefined) patch[identityAttributes.agentSeat] = input.agentSeat;
    if (input.model !== undefined) patch[identityAttributes.model] = input.model;
    if (input.thinkingLevel !== undefined)
      patch[identityAttributes.thinkingLevel] = input.thinkingLevel;
    if (Object.keys(patch).length > 0) ctx.graph.update(record.id, { attributes: patch });

    if (input.parentNativeSessionId !== undefined) {
      if (input.parentNativeSessionId === input.nativeSessionId)
        throw new Fault("identity", "A native session cannot be its own parent");

      const parent = nativeStartup(ctx, {
        provider: input.provider,
        nativeSessionId: input.parentNativeSessionId,
      });
      const recordId = record.id;
      const oldParent = ctx.graph
        .edges(recordId, identityRelations.spawned)
        .find((edge) => edge.to_id === recordId);
      if (oldParent !== undefined && oldParent.from_id !== parent.nodeId)
        throw new Fault("identity", "Native parent attribution conflicts");

      ctx.graph.connect(parent.nodeId, record.id, identityRelations.spawned);
    }

    return {
      identity: identityId,
      nodeId: record.id,
      result,
      instruction: identityInstruction(identityId),
    };
  }, authority);
}

export function observeIdentity(ctx: Context, input: NativeObservation) {
  return ctx.graph.atomic(() => {
    const binding = nativeStartup(ctx, input);
    const record = ctx.graph.show(binding.nodeId);
    const previous = activitySchema.parse(
      record.attributes[identityAttributes.activity] ?? "unknown",
    );

    const attributes: Attributes = {
      [identityAttributes.activity]: observedActivity(input.event, previous),
      [identityAttributes.lastEvent]: input.event,
      [identityAttributes.observedAt]: ctx.clock.now(),
      [identityAttributes.cwd]: input.cwd,
    };
    if (input.nativeEvent !== undefined)
      attributes[identityAttributes.nativeEvent] = input.nativeEvent;
    if (input.sessionPath !== undefined)
      attributes[identityAttributes.sessionPath] = input.sessionPath;
    if (input.capabilities !== undefined)
      attributes[identityAttributes.capabilities] = input.capabilities;

    ctx.graph.update(binding.nodeId, {
      state: match(input.event)
        .with("session-end", () => "closed" as const)
        .with("session-start", "agent-start", () => "active" as const)
        .with("metadata", "agent-end", (): undefined => undefined)
        .exhaustive(),
      attributes,
    });

    return binding;
  }, authority);
}

// Agents owns run admission; Identity owns the provenance edge, never process custody.
export function recordParticipation(
  ctx: Context,
  identityId: string,
  runId: string,
  invocation: string,
): void {
  const record = requireValue(resolveIdentity(ctx.graph, identityId), "Unknown native identity");
  ctx.graph.atomic(
    () => ctx.graph.connect(record.id, runId, identityRelations.performed, { invocation }),
    authority,
  );
}

export function identity(): Extension {
  return {
    name: "identity",
    source: import.meta.url,
    activate(ctx) {
      ctx.graph.protect((changes, token) => {
        if (token === authority) return;

        for (const change of changes) {
          if (
            change.kind === "node" &&
            [identityAttributes.id, identityAttributes.session].some(
              (key) =>
                change.before?.attributes[key] !== undefined ||
                change.after?.attributes[key] !== undefined,
            )
          )
            throw new Fault("identity-guard", "Identity records require the Identity API");
          if (
            change.kind === "edge" &&
            [change.before?.relation, change.after?.relation].some(
              (relation) =>
                relation === identityRelations.performed || relation === identityRelations.spawned,
            )
          )
            throw new Fault("identity-guard", "Native attribution requires the Identity API");
        }
      });
      ctx.graph.declareAcyclic(identityRelations.spawned);
      const commandSchema = z.compile(
        z.discriminatedUnion("command", [
          startupSchema.extend({ command: z.literal("startup") }),
          z.strictObject({ command: z.literal("show"), identity: text.optional() }),
          z.strictObject({
            command: z.literal("list"),
            limit: z.number().int().min(1).max(100).default(20),
            offset: z.number().int().nonnegative().default(0),
          }),
        ]),
      );
      ctx.register(
        defineOp({
          name: "identity",
          about:
            "Identity names are deterministic labels for provider-scoped native sessions. Records retain attribution and last-reported metadata; they do not grant process custody, prove liveness or complete tasks.",
          primer:
            "Use startup to register or recover a native session, show to inspect one identity (defaults to the invocation caller), and list to find registered identities. Omitted startup seat/model/effort use BL_AGENT_SEAT, BL_MODEL and BL_EFFORT from the caller environment; explicit values win.",
          input: commandSchema,
          output: jsonSchema,
          jsonSchema: { input: commandSchema, output: jsonSchema },
          cli: {
            description: "Native session identities and observations",
            examples: [
              "bl identity startup --provider pi --native-session-id SESSION_ID",
              "bl identity show",
              "bl identity list",
            ],
            commands: {
              startup: {
                description:
                  "Register or recover a deterministic native identity; returns identity, nodeId, result and instruction",
                examples: [
                  "bl identity startup --provider pi --native-session-id SESSION_ID",
                  "bl identity startup --provider claude --native-session-id SESSION_ID --agent-seat reviewer",
                ],
                flags: {
                  provider: {
                    type: "string",
                    required: true,
                    description: "Provider namespace (for example: codex, pi, claude)",
                  },
                  "native-session-id": {
                    key: "nativeSessionId",
                    type: "string",
                    required: true,
                    description: "Provider-scoped native session ID",
                  },
                  "parent-native-session-id": {
                    key: "parentNativeSessionId",
                    type: "string",
                    description: "Optional parent session ID; records a spawned relationship",
                  },
                  "agent-seat": {
                    key: "agentSeat",
                    type: "string",
                    description: "Seat (defaults to BL_AGENT_SEAT)",
                  },
                  model: { type: "string", description: "Model (defaults to BL_MODEL)" },
                  "thinking-level": {
                    key: "thinkingLevel",
                    type: "string",
                    description: "Effort (defaults to BL_EFFORT)",
                  },
                },
              },
              show: {
                description:
                  "Show one full identity record and last observation (defaults to the invocation caller)",
                examples: ["bl identity show", "bl identity show IDENTITY"],
                positionals: [
                  {
                    name: "identity",
                    type: "string",
                    description: "Identity name (defaults to the invocation caller)",
                  },
                ],
              },
              list: {
                description:
                  "Page { identities, total, nextOffset } summaries; use show IDENTITY for full metadata",
                examples: [
                  "bl identity list",
                  "bl identity list --limit 20",
                  "bl identity list --limit 20 --offset NEXT_OFFSET",
                ],
                flags: {
                  limit: { type: "number", description: "Page size (default 20; range 1–100)" },
                  offset: {
                    type: "number",
                    description:
                      "Start index (default 0; minimum 0); continue with nextOffset until null",
                  },
                },
              },
            },
          },
          handler(input, _ctx, invocation) {
            switch (input.command) {
              case "startup": {
                const { command: _, ...request } = input;

                return nativeStartup(ctx, {
                  ...request,
                  ...agentMetadata(request, ctx.env.bl),
                });
              }
              case "show": {
                const name = requireValue(
                  input.identity ?? invocation.identity,
                  "Supply identity or caller identity",
                );
                return jsonSchema.parse(
                  requireValue(resolveIdentity(ctx.graph, name), "Unknown identity"),
                );
              }
              case "list": {
                const where = q.eq(q.attr(identityAttributes.session), true);
                const records = ctx.graph.list({ where, limit: input.limit, offset: input.offset });
                const total = ctx.graph.count({ where });
                return jsonSchema.parse({
                  identities: records.map((record) => ({
                    identity: record.attributes[identityAttributes.id],
                    nodeId: record.id,
                    provider: record.attributes[identityAttributes.provider],
                    activity: record.attributes[identityAttributes.activity],
                    observedAt: record.attributes[identityAttributes.observedAt] ?? null,
                  })),
                  total,
                  nextOffset:
                    input.offset + records.length < total ? input.offset + records.length : null,
                });
              }
            }
          },
        }),
      );
    },
  };
}

export default identity();
