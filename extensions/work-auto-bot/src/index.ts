import { isAbsolute } from "node:path";

import { q, type Extension, type RuntimeExtension } from "@botlake/core";
import { agentAttributes, agentRelations, type Agents } from "@botlake/extension-agents";
import { workAttributes, type WorkStore } from "@botlake/extension-work";
import { z } from "zod";

export const workAutoBotAttributes = {
  /** Explicit opt-in; only the boolean true admits work. */
  autoRun: "work-auto-bot/auto-run",
  /** Required available Agents seat; no implicit model selection. */
  seat: "work-auto-bot/seat",
  /** Optional absolute worker directory; absent uses the owning lake workspace. */
  cwd: "work-auto-bot/cwd",
  /** Rejected admission; clear explicitly after correcting the cause. */
  error: "work-auto-bot/error",
} as const;

const admissionSchema = z.compile(
  z.object({
    seat: z.string().trim().min(1),
    cwd: z.string().min(1).refine(isAbsolute, "cwd must be absolute").optional(),
  }),
);
const seatAvailability = z.compile(z.object({ available: z.boolean() }));
const wake = "work-auto-bot/scan";
const eligible = q.and(
  q.eq("state", "active"),
  q.eq(q.attr(workAttributes.item), true),
  q.eq(q.attr(workAttributes.kind), "task"),
  q.eq(q.attr(workAttributes.audience), "AFK"),
  q.eq(q.attr(workAutoBotAttributes.autoRun), true),
  q.missing(q.attr(workAutoBotAttributes.error)),
);

export interface WorkAutoBotBindings {
  /** The exact configured Agents binding selected in the same lake. */
  agents: RuntimeExtension<Agents>;
  /** The exact configured Work binding selected in the same lake. */
  work: RuntimeExtension<WorkStore>;
}

export function workAutoBot(bindings: WorkAutoBotBindings): Extension {
  return {
    name: "work-auto-bot",
    source: import.meta.url,
    requires: [bindings.work.name, bindings.agents.name],
    activate(ctx) {
      const agents = bindings.agents.instance(ctx);
      const work = bindings.work.instance(ctx);

      function scan(): void {
        for (const candidate of ctx.graph.all({ where: eligible, ready: true })) {
          if (candidate.reference !== null) continue;
          try {
            ctx.graph.atomic(() => {
              // Recheck readiness and ownership in the same synchronous transaction as admission.
              const node = ctx.graph.all({
                where: q.and(eligible, q.eq("id", candidate.id)),
                ready: true,
              })[0];
              if (node === undefined || node.reference !== null) return;
              const task = work.get(node.id);
              if (task.kind !== "task" || task.assignment !== null) return;
              const requestId = `work-auto-bot/${node.id}`;
              if (
                agents
                  .runs()
                  .some(
                    (run) =>
                      run.attributes[agentAttributes.requestId] === requestId ||
                      (run.attributes[agentAttributes.external] !== true &&
                        run.attributes[agentAttributes.settled] !== true &&
                        ctx.graph.edge(run.id, node.id, agentRelations.serves) !== null),
                  )
              )
                return;

              const admission = admissionSchema.parse({
                seat: node.attributes[workAutoBotAttributes.seat],
                cwd: node.attributes[workAutoBotAttributes.cwd],
              });
              if (!seatAvailability.parse(agents.catalog(admission.seat)).available) return;
              agents.start({
                requestId,
                target: node.id,
                seat: admission.seat,
                cwd: admission.cwd ?? ctx.workspace,
                policy: "close-on-complete",
                prompt: `Work assigned task ${node.id}. Inspect its brief and context. Claim this exact task as your own identity and retain the returned assignment.id. Proactively resolve blockers. If a blocker conflicts with the task, seek Oracle counsel. If still blocked, create an unplanned HITL prerequisite, link the served task as depending on it, release only your exact assignment token, and stop. When satisfied, submit the authored workflow outcome when applicable; otherwise close the satisfied task.`,
              });
            });
          } catch (error) {
            // A rejected admission is not a worker retry policy. Keep it visible and latched.
            ctx.graph.setAttributes(candidate.id, {
              [workAutoBotAttributes.error]: String(error),
            });
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
