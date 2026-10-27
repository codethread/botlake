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
import { z } from "zod";

const authority = Symbol("identity");
const text = z.string().trim().min(1);
const provider = z.enum(["codex", "claude", "pi", "cursor"]);
export const startupSchema = z.strictObject({
  harness: provider,
  nativeSessionId: text,
  identity: text.optional(),
  reservationId: text.optional(),
  parentIdentity: text.optional(),
  runId: text.optional(),
  invocation: text.optional(),
  model: text.optional(),
  thinkingLevel: text.optional(),
});
export type Startup = z.infer<typeof startupSchema>;
export function identityRecords(graph: Graph): Node[] {
  return graph.all({
    where: q.exists(q.attr("identity/id")),
    lean: false,
  });
}
export function resolveIdentity(graph: Graph, name: string): Node | undefined {
  return identityRecords(graph).find((record) => record.attributes["identity/id"] === name);
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
export function reserveIdentity(
  ctx: Context,
  input: { harness: string; model?: string | undefined; thinkingLevel?: string | undefined },
): { identity: string; reservationId: string; nodeId: string } {
  const harness = provider.parse(input.harness);
  return ctx.graph.atomic(() => {
    const friendly = `agent-${crypto.randomUUID().slice(0, 8)}`;
    const reservationId = crypto.randomUUID();
    const attributes: Attributes = {
      "identity/session": true,
      "identity/id": friendly,
      "identity/harness": harness,
      "identity/reservation-id": reservationId,
      "identity/reservation-state": "reserved",
    };
    if (input.model !== undefined) attributes["identity/model"] = input.model;
    if (input.thinkingLevel !== undefined)
      attributes["identity/thinking-level"] = input.thinkingLevel;
    const node = ctx.graph.add({ title: friendly, attributes });
    return { identity: friendly, reservationId, nodeId: node.id };
  }, authority);
}
export function nativeStartup(
  ctx: Context,
  raw: Startup,
): {
  identity: string;
  nodeId: string;
  result: "created" | "attached" | "recovered";
  instruction: string;
} {
  const input = startupSchema.parse(raw);
  return ctx.graph.atomic(() => {
    const records = identityRecords(ctx.graph);
    let record = records.find(
      (entry) =>
        entry.attributes["identity/harness"] === input.harness &&
        entry.attributes["identity/native-session-id"] === input.nativeSessionId,
    );
    let result: "created" | "attached" | "recovered" = "recovered";
    if (record !== undefined) {
      if (input.identity !== undefined && record.attributes["identity/id"] !== input.identity)
        throw new Fault("identity", "Native session identity mismatch");
      if (
        input.reservationId !== undefined &&
        record.attributes["identity/reservation-id"] !== input.reservationId
      )
        throw new Fault("identity", "Reservation mismatch");
    } else if (input.reservationId !== undefined) {
      record = requireValue(
        records.find(
          (entry) => entry.attributes["identity/reservation-id"] === input.reservationId,
        ),
        "Unknown identity reservation",
      );
      if (
        record.attributes["identity/reservation-state"] !== "reserved" ||
        record.attributes["identity/harness"] !== input.harness ||
        (input.identity !== undefined && record.attributes["identity/id"] !== input.identity)
      )
        throw new Fault("identity", "Reservation cannot attach this session");
      result = "attached";
    } else {
      if (input.identity !== undefined)
        throw new Fault("identity", "An identity name cannot authorize a new native binding");
      const reserved = reserveIdentity(ctx, {
        harness: input.harness,
        model: input.model,
        thinkingLevel: input.thinkingLevel,
      });
      record = ctx.graph.show(reserved.nodeId);
      result = "created";
    }
    const parent =
      input.parentIdentity === undefined
        ? undefined
        : requireValue(resolveIdentity(ctx.graph, input.parentIdentity), "Unknown parent identity");
    if (input.runId !== undefined) {
      const run = ctx.graph.show(input.runId);
      if (
        run.attributes["harness/run"] !== true ||
        run.attributes["harness/identity"] !== record.attributes["identity/id"]
      )
        throw new Fault("identity", "Run identity does not authorize this registration");
      if (
        run.attributes["harness/provider"] !== input.harness ||
        (run.attributes["harness/external"] !== true &&
          (run.attributes["harness/state"] !== "running" ||
            input.invocation === undefined ||
            run.attributes["harness/invocation"] !== input.invocation))
      )
        throw new Fault("identity", "Stale native invocation");
      const expected = run.attributes["harness/session-id"];
      if (expected !== undefined && expected !== input.nativeSessionId)
        throw new Fault("identity", "Run native session mismatch");
      ctx.graph.connect(record.id, run.id, "performed", {
        invocation: input.invocation ?? "external",
      });
    }
    const patch: Attributes = {
      "identity/native-session-id": input.nativeSessionId,
      "identity/reservation-state": "attached",
    };
    if (input.model !== undefined) patch["identity/model"] = input.model;
    if (input.thinkingLevel !== undefined) patch["identity/thinking-level"] = input.thinkingLevel;
    if (parent !== undefined) {
      const recordId = record.id;
      const oldParent = ctx.graph
        .edges(recordId, "spawned")
        .find((edge) => edge.to_id === recordId);
      if (oldParent !== undefined && oldParent.from_id !== parent.id)
        throw new Fault("identity", "Native parent attribution conflicts");
      ctx.graph.connect(parent.id, record.id, "spawned");
    }
    record = ctx.graph.update(record.id, { attributes: patch });
    const name = text.parse(record.attributes["identity/id"]);
    return {
      identity: name,
      nodeId: record.id,
      result,
      instruction: `Your identity is ${name}. Preserve it when recording ownership and authorship.`,
    };
  }, authority);
}
export function codexChildSessionId(parent: string, agent: string): string {
  return `codex-child:v1:${Buffer.from(text.parse(parent)).toString("base64url")}:${Buffer.from(text.parse(agent)).toString("base64url")}`;
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
            "Native adapters register actual provider session ids at startup. Inspect list or show to resolve attribution. Identity evidence alone grants no process ownership or permission to stop an external session.",
          input: commandSchema,
          output: z.json(),
          cli: {
            description: "Native session identities",
            examples: ["bl identity list", "bl identity show IDENTITY"],
            commands: {
              startup: {
                description: "Register actual native session",
                flags: {
                  harness: { type: "string", required: true },
                  "native-session-id": { key: "nativeSessionId", type: "string", required: true },
                  identity: { type: "string" },
                  "reservation-id": { key: "reservationId", type: "string" },
                  "parent-identity": { key: "parentIdentity", type: "string" },
                  "run-id": { key: "runId", type: "string" },
                  invocation: { type: "string" },
                  model: { type: "string" },
                  "thinking-level": { key: "thinkingLevel", type: "string" },
                },
              },
              show: {
                description: "Resolve identity",
                positionals: [{ name: "identity", type: "string", required: true }],
              },
              list: { description: "List identities" },
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
                return z
                  .json()
                  .parse(ctx.graph.all({ where: q.eq(q.attr("identity/session"), true) }));
            }
          },
        }),
      );
    },
  };
}

export default identity();
