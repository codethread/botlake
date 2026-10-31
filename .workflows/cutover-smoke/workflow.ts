import { setup } from "xstate";
import { z } from "zod";

/** A tiny authored workflow for live coordination checks; it performs no external effects. */
export const inputSchema = z.object({});
export const commandSchemas = { next: z.object({}), approved: z.object({}) };

export function runBrief() {
  return {
    title: "Cutover workflow smoke",
    description: "Record a dummy result, then exercise an explicit HITL checkpoint.",
  };
}

export const machine = setup({}).createMachine({
  id: "cutover-smoke",
  initial: "produce",
  states: {
    produce: {
      meta: {
        title: "Cutover workflow: record result",
        commands: { next: "NEXT" },
        task: () => ({
          instructions:
            "Record cutover-20261031-live/workflow in notes, resolve the criterion and close this Work task. The parent submits the authored outcome separately.",
          acceptanceCriteria: ["Record the dummy workflow result and execution identity."],
        }),
      },
      on: { NEXT: "review" },
    },
    review: {
      meta: {
        title: "Cutover workflow: parent checkpoint",
        commands: { approved: "APPROVED" },
        task: () => ({
          instructions:
            "Dummy checkpoint: inspect the recorded result, then explicitly submit approved. This is a smoke exercise, not a real human approval.",
          audience: "HITL",
          assignee: "remaining-quixotic-quelea",
        }),
      },
      on: { APPROVED: "done" },
    },
    done: { type: "final" },
  },
});
