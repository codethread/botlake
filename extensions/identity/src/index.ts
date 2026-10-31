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
import { z } from "zod";

import { identityAttributes, identityRelations, type AttributionRelation } from "./node-model.ts";

export { identityAttributes, identityRelations } from "./node-model.ts";
export type { AttributionRelation } from "./node-model.ts";

const authority = Symbol("identity");

const text = z.compile(z.string().trim().min(1));
const optionalText = z.compile(text.optional());

export const startupSchema = z.compile(
  sessionSchema.extend({
    parentNativeSessionId: text.optional(),
    ...agentMetadataSchema.shape,
  }),
);

export type Startup = z.infer<typeof startupSchema>;

export function callerActor(ctx: Context): string | undefined {
  return optionalText.parse(ctx.env.bl["BL_ACTOR"]);
}

export function identityRecords(graph: Graph): Node[] {
  return graph.all({ where: q.eq(q.attr(identityAttributes.session), true), lean: false });
}

export function resolveIdentity(graph: Graph, name: string): Node | undefined {
  return graph.all({ where: q.eq(q.attr(identityAttributes.id), name), lean: false })[0];
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

    ctx.graph.update(binding.nodeId, { attributes });

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
    activate(ctx) {
      ctx.graph.protect((changes, token) => {
        if (token === authority) return;

        for (const change of changes) {
          if (
            change.kind === "node" &&
            (change.before?.attributes[identityAttributes.id] !== undefined ||
              change.after?.attributes[identityAttributes.id] !== undefined)
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
          z.strictObject({ command: z.literal("list") }),
        ]),
      );
      ctx.register(
        defineOp({
          name: "identity",
          primer:
            "Native sessions derive deterministic identities from provider and native session id. Show defaults to the caller's BL_ACTOR. Startup defaults agent seat, model and thinking level from BL_AGENT_SEAT, BL_MODEL and BL_EFFORT; explicit input wins. Show includes the last reported activity and metadata, not a liveness guarantee. Identity grants no process custody or task completion authority.",
          input: commandSchema,
          output: jsonSchema,
          cli: {
            description: "Native session identities and observations",
            examples: ["bl identity list", "bl identity show IDENTITY"],
            commands: {
              startup: {
                description: "Register a native identity without process ownership",
                flags: {
                  provider: { type: "string", required: true },
                  "native-session-id": { key: "nativeSessionId", type: "string", required: true },
                  "parent-native-session-id": { key: "parentNativeSessionId", type: "string" },
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
                description: "Identity and last reported native activity (defaults to BL_ACTOR)",
                positionals: [{ name: "identity", type: "string" }],
              },
              list: { description: "List native identities" },
            },
          },
          handler(input) {
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
                  input.identity ?? callerActor(ctx),
                  "Supply identity or BL_ACTOR",
                );
                return jsonSchema.parse(
                  requireValue(resolveIdentity(ctx.graph, name), "Unknown identity"),
                );
              }
              case "list":
                return jsonSchema.parse(identityRecords(ctx.graph));
            }
          },
        }),
      );
    },
  };
}

export default identity();
