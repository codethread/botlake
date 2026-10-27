import {
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
  identityInstruction,
  observedActivity,
  sessionIdentity,
  sessionSchema,
  type NativeObservation,
} from "@botlake/native-session";
import { z } from "zod";

const authority = Symbol("identity");
const text = z.string().trim().min(1);
export const startupSchema = sessionSchema.extend({
  parentNativeSessionId: text.optional(),
  model: text.nullable().optional(),
  thinkingLevel: text.nullable().optional(),
});
export type Startup = z.infer<typeof startupSchema>;

export function identityRecords(graph: Graph): Node[] {
  return graph.all({ where: q.eq(q.attr("identity/session"), true), lean: false });
}
export function resolveIdentity(graph: Graph, name: string): Node | undefined {
  return graph.all({ where: q.eq(q.attr("identity/id"), name), lean: false })[0];
}
export function attribution(graph: Graph, name: string): { identity: string; nodeIds: string[] } {
  const record = resolveIdentity(graph, name);
  return { identity: name, nodeIds: record === undefined ? [] : [record.id] };
}
export function attribute(
  ctx: Context,
  target: string,
  name: string,
  relation: "attributed" | "reported" | "claimed",
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
    const result = record === undefined ? "created" : "recovered";
    record ??= ctx.graph.add({
      title: `${input.provider} ${input.nativeSessionId}`,
      attributes: {
        "identity/session": true,
        "identity/id": identityId,
        "identity/provider": input.provider,
        "identity/native-session-id": input.nativeSessionId,
        "identity/activity": "unknown",
      },
    });
    const patch: Attributes = {};
    if (input.model !== undefined) patch["identity/model"] = input.model;
    if (input.thinkingLevel !== undefined) patch["identity/thinking-level"] = input.thinkingLevel;
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
        .edges(recordId, "spawned")
        .find((edge) => edge.to_id === recordId);
      if (oldParent !== undefined && oldParent.from_id !== parent.nodeId)
        throw new Fault("identity", "Native parent attribution conflicts");
      ctx.graph.connect(parent.nodeId, record.id, "spawned");
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
    const previous = activitySchema.parse(record.attributes["identity/activity"] ?? "unknown");
    const attributes: Attributes = {
      "identity/activity": observedActivity(input.event, previous),
      "identity/last-event": input.event,
      "identity/observed-at": ctx.clock.now(),
      "identity/cwd": input.cwd,
    };
    if (input.nativeEvent !== undefined) attributes["identity/native-event"] = input.nativeEvent;
    if (input.sessionPath !== undefined) attributes["identity/session-path"] = input.sessionPath;
    if (input.capabilities !== undefined) attributes["identity/capabilities"] = input.capabilities;
    ctx.graph.update(binding.nodeId, { attributes });
    return binding;
  }, authority);
}

// Harnesses owns run admission; Identity owns the provenance edge, never process custody.
export function recordParticipation(
  ctx: Context,
  identityId: string,
  runId: string,
  invocation: string,
): void {
  const record = requireValue(resolveIdentity(ctx.graph, identityId), "Unknown native identity");
  ctx.graph.atomic(
    () => ctx.graph.connect(record.id, runId, "performed", { invocation }),
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
            (change.before?.attributes["identity/id"] !== undefined ||
              change.after?.attributes["identity/id"] !== undefined)
          )
            throw new Fault("identity-guard", "Identity records require the Identity API");
          if (
            change.kind === "edge" &&
            [change.before?.relation, change.after?.relation].some(
              (relation) => relation === "performed" || relation === "spawned",
            )
          )
            throw new Fault("identity-guard", "Native attribution requires the Identity API");
        }
      });
      ctx.graph.declareAcyclic("spawned");
      const commandSchema = z.discriminatedUnion("command", [
        startupSchema.extend({ command: z.literal("startup") }),
        z.strictObject({ command: z.literal("show"), identity: text }),
        z.strictObject({ command: z.literal("list") }),
      ]);
      ctx.register(
        defineOp({
          name: "identity",
          primer:
            "Native sessions derive deterministic identities from provider and native session id. Show includes the last reported activity and metadata, not a liveness guarantee. Identity grants no process custody or task completion authority.",
          input: commandSchema,
          output: z.json(),
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
                  model: { type: "string" },
                  "thinking-level": { key: "thinkingLevel", type: "string" },
                },
              },
              show: {
                description: "Identity and last reported native activity",
                positionals: [{ name: "identity", type: "string", required: true }],
              },
              list: { description: "List native identities" },
            },
          },
          handler(input) {
            switch (input.command) {
              case "startup": {
                const { command: _, ...request } = input;
                return nativeStartup(ctx, request);
              }
              case "show":
                return z
                  .json()
                  .parse(
                    requireValue(resolveIdentity(ctx.graph, input.identity), "Unknown identity"),
                  );
              case "list":
                return z.json().parse(identityRecords(ctx.graph));
            }
          },
        }),
      );
    },
  };
}
export default identity();
