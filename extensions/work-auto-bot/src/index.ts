import { isAbsolute } from "node:path";

import { Fault, q, type Extension, type Node, type RuntimeExtension } from "@botlake/core";
import { agentAttributes as a, agentRelations, type Agents } from "@botlake/extension-agents";
import { workAttributes, type WorkStore } from "@botlake/extension-work";
import { z } from "zod";

export const workAutoBotAttributes = {
  /** Explicit opt-in; false also pauses automatic continuations, including Mail. */
  autoRun: "work-auto-bot/auto-run",
  /** Required available Agents seat; no implicit worker model selection. */
  seat: "work-auto-bot/seat",
  /** Optional absolute directory; initial admission defaults to the owning lake workspace. */
  cwd: "work-auto-bot/cwd",
  /** Rejected admission; clear explicitly after correcting the cause. */
  error: "work-auto-bot/error",
  /** Terminal worker exhaustion reason. Run/continuation history retains the budget and Oracle. */
  exhausted: "work-auto-bot/exhausted",
} as const;

const admissionSchema = z.compile(
  z.object({
    seat: z.string().trim().min(1),
    cwd: z.string().min(1).refine(isAbsolute, "cwd must be absolute").optional(),
  }),
);
const text = z.compile(z.string().min(1));
const seatAvailability = z.compile(z.object({ available: z.boolean() }));
const wake = "work-auto-bot/scan";
const eligible = q.and(
  q.eq("state", "active"),
  q.eq(q.attr(workAttributes.item), true),
  q.eq(q.attr(workAttributes.kind), "task"),
  q.eq(q.attr(workAttributes.audience), "AFK"),
  q.eq(q.attr(workAutoBotAttributes.autoRun), true),
  q.missing(q.attr(workAutoBotAttributes.error)),
  q.missing(q.attr(workAutoBotAttributes.exhausted)),
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
      ctx.registerQuery("work-auto-bot-exhausted", {
        description:
          "Tasks whose automatic worker recovery is terminal; inspect notes and Agents history",
        where: q.and(
          q.eq(q.attr(workAttributes.kind), "task"),
          q.exists(q.attr(workAutoBotAttributes.exhausted)),
        ),
      });

      function available(seat: string): boolean {
        return seatAvailability.parse(agents.catalog(seat)).available;
      }

      function lineage(task: string): Node[] {
        const runs = agents.runs();
        const root = runs.find((run) => run.attributes[a.requestId] === `work-auto-bot/${task}`);
        const chain: Node[] = [];
        let next = root;
        while (next !== undefined) {
          chain.push(next);
          const parentId = next.id;
          const child = ctx.graph
            .edges(parentId, agentRelations.continues)
            .find((edge) => edge.to_id === parentId);
          next = child === undefined ? undefined : ctx.graph.show(child.from_id);
        }
        return chain;
      }

      function ready(task: string): Node | undefined {
        const node = ctx.graph.all({ where: q.and(eligible, q.eq("id", task)), ready: true })[0];
        if (node === undefined || node.reference !== null) return;
        const item = work.get(task);
        if (item.kind !== "task" || item.assignment !== null) return;
        if (
          agents
            .runs()
            .some(
              (run) =>
                run.attributes[a.external] !== true &&
                run.attributes[a.settled] !== true &&
                ctx.graph.edge(run.id, task, agentRelations.serves) !== null,
            )
        )
          return;
        return node;
      }

      function continuationAvailable(parent: Node): boolean {
        if (
          !available(text.parse(parent.attributes[a.seat])) ||
          !available(text.parse(parent.attributes[a.provider]))
        )
          return false;
        return parent.attributes[a.sessionId] === undefined || agents.sessionAvailable(parent.id);
      }

      // Mail and this scanner share the same atomic Agents admission fence. Manual resume stays explicit.
      agents.guardAutomaticContinuation((parent) => {
        const target = ctx.graph
          .edges(parent.id, agentRelations.serves)
          .find((edge) => edge.from_id === parent.id)?.to_id;
        if (target === undefined) return;
        const chain = lineage(target);
        if (chain.length === 0) return;
        const node = ready(target);
        if (
          node === undefined ||
          chain.at(-1)?.id !== parent.id ||
          chain.length > 3 ||
          chain.some((run) => cancelled(run)) ||
          !available(text.parse(node.attributes[workAutoBotAttributes.seat])) ||
          !continuationAvailable(parent)
        )
          throw new Fault(
            "automatic-continuation",
            "Automatic Work continuation is paused or exhausted",
          );
      });

      function exhaust(task: string, parent: Node, reason: string): void {
        // Like an exhausted gate: no timer resets the budget, no success is inferred, manual action remains possible.
        ctx.graph.setAttributes(task, { [workAutoBotAttributes.exhausted]: reason });
        let diagnostic: string;
        try {
          if (!available("oracle")) throw new Fault("seat", "Oracle seat unavailable");
          const oracle = agents.start({
            requestId: `work-auto-bot/${task}/oracle`,
            target: task,
            seat: "oracle",
            cwd: text.parse(parent.attributes[a.cwd]),
            policy: "stop-on-complete",
            prompt: `Automatic worker recovery for task ${task} is exhausted: ${reason}. You are the ONE automatic Oracle debugger admission, not a retry coordinator. Re-read this task, its current blockers, notes and linked Agents continuation history (latest worker ${parent.id}). Claim this exact task using your own identity and retain assignment.id. Proactively investigate and fix the underlying cause; normal worker settlement did not prove task success or interruption. Use Work gates for machine-checkable waits. Only after diagnosis, create an unplanned HITL prerequisite for remaining human-only input, link it to this task and release only your exact assignment. Record evidence and the next responsible actor in task notes before stopping. Do not reset the automatic budget, spawn replacement workers or arrange automatic self-retries. If further execution is needed, document a specific manual recovery handoff. Close the original task only if its intended outcome is actually satisfied; submit an authored workflow outcome when applicable.`,
          });
          diagnostic = `One-shot Oracle debugger: ${oracle.id}. Inspect its custody/result with agent show. Oracle failure, missing session, cancellation or unfinished settlement requires explicit manual diagnosis/recovery; neither Mail nor polling will resume it automatically.`;
        } catch (error) {
          diagnostic = `Oracle admission failed: ${String(error)}. Repair the seat/worktree and explicitly launch a debugger; no automatic reattempt.`;
          ctx.graph.setAttributes(task, { [workAutoBotAttributes.error]: diagnostic });
        }
        const item = work.get(task);
        if (item.kind === "task")
          work.update(task, {
            notes: [item.notes, `Automatic recovery exhausted: ${reason}. ${diagnostic}`]
              .filter(Boolean)
              .join("\n\n"),
          });
      }

      function scan(): void {
        for (const candidate of ctx.graph.all({ where: eligible, ready: true })) {
          if (candidate.reference !== null) continue;
          try {
            ctx.graph.atomic(() => {
              // Re-read task, assignment, readiness and custody in the admission transaction.
              const node = ready(candidate.id);
              if (node === undefined) return;
              const chain = lineage(node.id);
              const parent = chain.at(-1);
              if (chain.some((run) => cancelled(run))) return;
              if (parent !== undefined) {
                if (parent.attributes[a.settled] !== true) return;
                if (chain.length > 3) {
                  exhaust(
                    node.id,
                    parent,
                    "Three continuations after initial admission have been spent",
                  );
                  return;
                }
                if (
                  parent.attributes[a.sessionConfirmed] !== true &&
                  !(
                    (parent.attributes[a.lifecycle] === "preparationFailed" ||
                      parent.attributes[a.lifecycle] === "launchFailed") &&
                    parent.attributes[a.sessionId] === undefined
                  )
                ) {
                  exhaust(
                    node.id,
                    parent,
                    "Settled worker has no verified resumable session and is not a pre-session launch failure",
                  );
                  return;
                }
              }
              const admission = admissionSchema.parse({
                seat: node.attributes[workAutoBotAttributes.seat],
                cwd: node.attributes[workAutoBotAttributes.cwd],
              });
              if (!available(admission.seat)) return;
              const prompt = workerPrompt(node.id);
              if (parent === undefined) {
                agents.start({
                  requestId: `work-auto-bot/${node.id}`,
                  target: node.id,
                  seat: admission.seat,
                  cwd: admission.cwd ?? ctx.workspace,
                  policy: "close-on-complete",
                  prompt,
                });
              } else if (continuationAvailable(parent)) {
                const requestId = `work-auto-bot/${node.id}/continue/${parent.id}`;
                if (parent.attributes[a.sessionConfirmed] === true)
                  agents.resumeAutomatically(parent.id, prompt, requestId);
                else agents.recoverLaunch(parent.id, prompt, requestId);
              }
            });
          } catch (error) {
            // Admission errors are visible and latched, never a second recovery ledger.
            ctx.graph.setAttributes(candidate.id, { [workAutoBotAttributes.error]: String(error) });
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

// -- Private helpers --

function cancelled(run: Node): boolean {
  return run.attributes[a.lifecycle] === "cancelled" || run.attributes[a.lifecycle] === "abandoned";
}

function workerPrompt(task: string): string {
  return `Work assigned task ${task}. Re-read its current brief, context, blockers and notes; previous execution may have ended normally with unfinished work. Claim this exact task as your own identity and retain the returned assignment.id; a resumed identity does not retain a released assignment. Proactively resolve blockers. Seek Oracle counsel for conflicting blockers. Use Work gates for machine-checkable waits. Only after diagnosis, create an unplanned HITL prerequisite for remaining human-only input, link this task as depending on it, release only your exact assignment token, and stop. To intentionally pause automation, set work-auto-bot/auto-run false before stopping. When satisfied, submit the authored workflow outcome when applicable; otherwise close the satisfied task.`;
}
