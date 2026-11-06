import {
  defineOp,
  Fault,
  jsonSchema,
  q,
  type Context,
  type Extension,
  type Node,
  type RuntimeExtension,
} from "@botlake/core";
import { agentAttributes as runAttrs, type Agents } from "@botlake/extension-agents";
import { mailAttributes, pendingPredicate } from "@botlake/extension-mail";
import { match } from "ts-pattern";
import { z } from "zod";

export const mailAgentAttributes = {
  /** Marks a one-shot permission to resume an explicitly waiting run. */
  wait: "mail-agents/wait",
  /** Exact managed run that registered this permission. */
  run: "mail-agents/run",
  /** Invocation generation that armed this permission; retries do not inherit it. */
  invocation: "mail-agents/invocation",
  /** Recipient identity verified against the run at registration. */
  identity: "mail-agents/identity",
  /** Absolute expiry; expiration never resumes the agent. */
  expiresAt: "mail-agents/expires-at",
  /** Admission outcome; resumed does not imply execution success. */
  state: "mail-agents/state",
} as const;

const a = mailAgentAttributes;
const authority = Symbol("mail-agents");
const wake = "mail-agents/scan";
const text = z.string().trim().min(1);
const stateSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("armed") }),
  z.object({ status: z.literal("resumed"), continuation: text }),
  z.object({ status: z.literal("expired") }),
  z.object({ status: z.literal("cancelled") }),
  z.object({ status: z.literal("failed"), error: text }),
]);
const dataSchema = z.object({
  [a.wait]: z.literal(true),
  [a.run]: text,
  [a.identity]: text,
  [a.invocation]: text,
  [a.expiresAt]: z.number(),
  [a.state]: stateSchema,
});
const input = z.discriminatedUnion("command", [
  z.strictObject({
    command: z.literal("arm"),
    run: text,
    timeoutSecs: z.number().int().positive().max(86400).default(300),
  }),
  z.strictObject({ command: z.literal("cancel"), id: text }),
  z.strictObject({ command: z.literal("show"), id: text }),
]);
const waiting = q.and(q.eq(q.attr(a.wait), true), q.eq(q.attr(a.state, "status"), "armed"));
const prompt =
  "Mail is pending for your identity. Load the mail primer, read and acknowledge your inbox, then continue your assigned task. This continuation consumes one mail wait permission. Acknowledgement means seen, not task completion. If the task still requires waiting after this turn, consult prime mail-agent and explicitly arm your current run again.";

/** Optional lifecycle composition; Mail itself neither owns nor wakes processes. */
export function mailAgents(bindings: { agents: RuntimeExtension<Agents> }): Extension {
  return {
    name: "mail-agents",
    source: import.meta.url,
    requires: ["mail", bindings.agents.name],
    activate(ctx) {
      const agents = bindings.agents.instance(ctx);
      ctx.graph.protect((changes, token) => {
        if (token === authority) return;
        for (const change of changes)
          if (
            change.kind === "node" &&
            (change.before?.attributes[a.wait] === true ||
              change.after?.attributes[a.wait] === true)
          )
            throw new Fault("mail-agents", "Wait registrations require the Mail Agents API");
      });
      ctx.registerQuery("mail-agent-wait-settled", {
        description:
          "One-shot wait expired, cancelled, failed or admitted a continuation; not task completion",
        params: ["id"],
        where: q.and(
          q.eq("id", q.param("id")),
          q.eq(q.attr(a.wait), true),
          q.ne(q.attr(a.state, "status"), "armed"),
        ),
      });
      ctx.register(
        defineOp({
          name: "mail-agent",
          input,
          output: jsonSchema,
          jsonSchema: { input, output: jsonSchema },
          primer:
            "For a running managed agent that needs future mail, mail-agent arm RUN_ID records one-shot permission to resume after this run completes normally. RUN_ID is the part of BL_RUN_REFERENCE before the colon. Arm before ending your turn, after acknowledging seen mail. The default permission expires after 300 seconds; --timeout-secs changes it (maximum 86400). This command does not stop or suspend the current process. Mail already pending also qualifies. mail-agent cancel WAIT_ID revokes an unconsumed permission; show WAIT_ID reports its state. Resume uses the same verified native session and occurs only after custody settles. A continuation must arm its own run again to wait further. Failed/cancelled runs are never resumed automatically. A completed task should cancel its wait before finishing. Use Batteries await when staying in the current turn; this operation covers ending a turn while still expecting mail.",
          cli: {
            description: "Opt in to one managed-session continuation for pending mail",
            commands: {
              arm: {
                description: "Authorize one resume after normal completion",
                positionals: [{ name: "run", type: "string", required: true }],
                flags: {
                  "timeout-secs": {
                    key: "timeoutSecs",
                    type: "number",
                    description: "Permission lifetime: default 300 seconds, maximum 86400",
                  },
                },
              },
              cancel: {
                description: "Revoke an unconsumed wait",
                positionals: [{ name: "id", type: "string", required: true }],
              },
              show: {
                description: "Inspect a wait and its continuation or failure",
                positionals: [{ name: "id", type: "string", required: true }],
              },
            },
          },
          handler(request, _context, invocation) {
            if (invocation.identity === null)
              throw new Fault("mail-agents", "Pass --identity before mail-agent");
            const identity = invocation.identity;
            return ctx.graph.atomic(
              () =>
                match(request)
                  .with({ command: "arm" }, ({ run, timeoutSecs }) =>
                    arm(ctx, run, identity, timeoutSecs),
                  )
                  .with({ command: "show" }, ({ id }) => present(ctx.graph.show(id)))
                  .with({ command: "cancel" }, ({ id }) => {
                    const node = ctx.graph.show(id);
                    const data = dataSchema.parse(node.attributes);
                    if (data[a.identity] !== identity)
                      throw new Fault("mail-agents", "Wait belongs to another identity");
                    if (data[a.state].status === "armed")
                      ctx.graph.setAttributes(id, { [a.state]: { status: "cancelled" } });
                    return present(ctx.graph.show(id));
                  })
                  .exhaustive(),
              authority,
            );
          },
        }),
      );
      function scan(): void {
        for (const node of ctx.graph.all({ where: waiting })) {
          try {
            ctx.graph.atomic(() => {
              reconcile(ctx, agents, ctx.graph.show(node.id));
            }, authority);
          } catch (error) {
            ctx.graph.atomic(
              () =>
                ctx.graph.setAttributes(node.id, {
                  [a.state]: { status: "failed", error: String(error) },
                }),
              authority,
            );
          }
        }
        ctx.scheduler.schedule(wake, ctx.clock.now() + 1000, wake);
      }
      ctx.scheduler.register(wake, scan);
      ctx.resource({
        start: scan,
        stop() {
          ctx.scheduler.cancel(wake);
        },
      });
    },
  };
}

function arm(ctx: Context, runId: string, identity: string, timeoutSecs: number) {
  const run = ctx.graph.show(runId);
  if (
    run.attributes[runAttrs.run] !== true ||
    run.attributes[runAttrs.external] === true ||
    run.attributes[runAttrs.state] !== "running" ||
    run.attributes[runAttrs.settled] === true ||
    run.attributes[runAttrs.sessionConfirmed] !== true ||
    run.attributes[runAttrs.identity] !== identity
  )
    throw new Fault(
      "mail-agents",
      "Arm requires your running managed run with a verified native identity",
    );
  const invocation = text.parse(run.attributes[runAttrs.invocation]);
  const existing = ctx.graph.list({
    where: q.and(
      q.eq(q.attr(a.wait), true),
      q.eq(q.attr(a.run), runId),
      q.eq(q.attr(a.invocation), invocation),
    ),
    limit: 1,
  })[0];
  if (existing !== undefined) return present(existing);
  return present(
    ctx.graph.add({
      title: `Mail wait for ${identity}`,
      attributes: {
        [a.wait]: true,
        [a.run]: runId,
        [a.identity]: identity,
        [a.invocation]: invocation,
        [a.expiresAt]: ctx.clock.now() + timeoutSecs * 1000,
        [a.state]: { status: "armed" },
      },
    }),
  );
}

function reconcile(ctx: Context, agents: Agents, node: Node): void {
  const data = dataSchema.parse(node.attributes);
  if (ctx.clock.now() >= data[a.expiresAt]) {
    ctx.graph.setAttributes(node.id, { [a.state]: { status: "expired" } });
    return;
  }
  const run = ctx.graph.show(data[a.run]);
  if (
    run.attributes[runAttrs.identity] !== data[a.identity] ||
    run.attributes[runAttrs.invocation] !== data[a.invocation]
  )
    throw new Fault(
      "mail-agents",
      "Waiting run identity or invocation changed; permission is no longer valid",
    );
  if (run.attributes[runAttrs.settled] !== true) return;
  if (run.attributes[runAttrs.lifecycle] !== "completed")
    throw new Fault(
      "mail-agents",
      `Waiting run settled as ${text.parse(run.attributes[runAttrs.lifecycle])}; no automatic resume`,
    );
  if (
    ctx.graph.count({
      where: q.and(pendingPredicate, q.eq(q.attr(mailAttributes.to), data[a.identity])),
      limit: 1,
    }) === 0
  )
    return;
  const continuation = agents.resume(run.id, prompt, `mail-agents/${node.id}`);
  ctx.graph.setAttributes(node.id, {
    [a.state]: { status: "resumed", continuation: continuation.id },
  });
}

function present(node: Node) {
  const data = dataSchema.parse(node.attributes);
  return {
    id: node.id,
    run: data[a.run],
    identity: data[a.identity],
    expiresAt: data[a.expiresAt],
    ...data[a.state],
  };
}
