import { setup } from "xstate";
import { z } from "zod";

export const inputSchema = z.object({});
export const commandSchemas = { approved: z.object({}), next: z.object({}), revise: z.object({}) };
export function runBrief() {
  return {
    description: "Prepare, implement and verify documentation and API branches, then hand off.",
    title: "Parallel implementation",
  };
}

// Commands are scoped to a branch: an unqualified NEXT would reach both regions.
export const machine = setup({}).createMachine({
  id: "parallel-work",
  initial: "prepare",
  states: {
    done: { type: "final" },
    handoff: {
      meta: {
        title: "Hand off change",
        commands: { next: "REPORTED" },
        task: () => ({ instructions: "Summarize both completed branches." }),
      },
      on: { REPORTED: "done" },
    },
    implementation: {
      meta: {
        title: "Implementation",
        task: () => ({ instructions: "Complete both branches." }),
      },
      onDone: "handoff",
      states: {
        api: {
          initial: "implement",
          meta: {
            title: "API",
            task: () => ({ instructions: "Implement and exercise the API." }),
          },
          states: {
            done: { type: "final" },
            implement: {
              meta: {
                title: "Implement API",
                commands: { next: "API.IMPLEMENTED" },
                task: () => ({ instructions: "Make the API change." }),
              },
              on: { "API.IMPLEMENTED": "verify" },
            },
            verify: {
              meta: {
                title: "Verify API",
                commands: { next: "API.VERIFIED" },
                task: () => ({ instructions: "Exercise the API contract." }),
              },
              on: { "API.VERIFIED": "done" },
            },
          },
        },
        docs: {
          initial: "write",
          meta: {
            title: "Documentation",
            task: () => ({ instructions: "Write and check the documentation." }),
          },
          states: {
            check: {
              meta: {
                title: "Check docs",
                commands: { approved: "DOCS.APPROVED", revise: "DOCS.REVISE" },
                task: () => ({
                  instructions: "Try the documented command; choose revise if it fails.",
                }),
              },
              on: { "DOCS.APPROVED": "done", "DOCS.REVISE": "write" },
            },
            done: { type: "final" },
            write: {
              meta: {
                title: "Write docs",
                commands: { next: "DOCS.WRITTEN" },
                task: () => ({ instructions: "Update the usage guide." }),
              },
              on: { "DOCS.WRITTEN": "check" },
            },
          },
        },
      },
      type: "parallel",
    },
    prepare: {
      meta: {
        title: "Prepare change",
        commands: { next: "PREPARED" },
        task: () => ({ instructions: "Identify the change to implement." }),
      },
      on: { PREPARED: "implementation" },
    },
  },
});
