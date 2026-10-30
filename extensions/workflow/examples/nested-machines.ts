import { setup } from "xstate";
import { z } from "zod";

export const inputSchema = z.object({});
export const commandSchemas = { next: z.object({}) };

interface WorkerInput {
  /** State node ID of the native group containing this actor's visits. */
  group: string;
  /** Branch whose work this actor coordinates. */
  branch: string;
}

export const worker = setup({
  // XState's setup interface uses this empty-object type witness.
  // oxlint-disable-next-line typescript/no-unnecessary-type-assertion, typescript/no-unsafe-type-assertion
  types: {} as { context: WorkerInput; input: WorkerInput },
}).createMachine({
  id: "nested-worker",
  context: ({ input }) => input,
  initial: "implement",
  states: {
    implement: {
      meta: {
        title: "Implement branch",
        commands: { next: "IMPLEMENTED" },
        task: ({ context }: { context: WorkerInput }) => ({
          title: `Implement ${context.branch}`,
          bee: { kind: "worker" },
          instructions: `Implement the ${context.branch} change and record focused verification.`,
        }),
      },
      on: { IMPLEMENTED: "verify" },
    },
    verify: {
      meta: {
        title: "Verify branch",
        commands: { next: "VERIFIED" },
        task: ({ context }: { context: WorkerInput }) => ({
          title: `Verify ${context.branch}`,
          bee: { kind: "reviewer" },
          instructions: `Inspect the ${context.branch} result and its verification evidence.`,
        }),
      },
      on: { VERIFIED: "done" },
    },
    done: { type: "final" },
  },
});

export const machine = setup({ actors: { worker } }).createMachine({
  id: "nested-bees",
  initial: "team",
  states: {
    team: {
      type: "parallel",
      meta: {
        title: "Build both branches",
        task: () => ({
          instructions:
            "Wait for both child machines to finish implementation and review. " +
            "Each visit is delegated to a separate Bee.",
        }),
      },
      onDone: "handoff",
      states: {
        api: {
          initial: "working",
          meta: {
            title: "API branch",
            task: () => ({ instructions: "Complete the API child machine's work and review." }),
          },
          states: {
            working: {
              invoke: {
                id: "api",
                src: "worker",
                input: { group: "nested-bees.team.api", branch: "API" },
                onDone: "done",
              },
            },
            done: { type: "final" },
          },
        },
        interface: {
          initial: "working",
          meta: {
            title: "Interface branch",
            task: () => ({
              instructions: "Complete the interface child machine's work and review.",
            }),
          },
          states: {
            working: {
              invoke: {
                id: "interface",
                src: "worker",
                input: { group: "nested-bees.team.interface", branch: "interface" },
                onDone: "done",
              },
            },
            done: { type: "final" },
          },
        },
      },
    },
    handoff: {
      meta: {
        title: "Summarize both branches",
        commands: { next: "REPORTED" },
        task: () => ({ instructions: "Synthesize the four completed Bee-dispatched visits." }),
      },
      on: { REPORTED: "done" },
    },
    done: { type: "final" },
  },
});

export function runBrief() {
  return {
    title: "Nested Bee work",
    description:
      "Build and review two branches with Bee-dispatched visits inside child machines, then summarize their results.",
  };
}
