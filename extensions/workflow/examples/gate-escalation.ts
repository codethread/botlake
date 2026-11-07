import { existsSync } from "node:fs";

import { defineProbe, type GateStatus } from "@botlake/extension-work";
import { defineWorkflow, type GateEventData } from "@botlake/extension-workflow";
import { assign, setup } from "xstate";
import { z } from "zod";

const inputSchema = z.object({ flag: z.string().min(1) });
const commandSchemas = {
  retry: z.object({}),
  waive: z.object({}),
  done: z.object({}),
};

const probes = [
  defineProbe({
    name: "flag-exists",
    description: "Wait for a local flag file",
    params: z.object({ path: z.string().min(1) }),
    policy: { everyMs: 1_000, maxAttempts: 2, timeoutMs: 1_000 },
    async run({ path }) {
      return existsSync(path)
        ? { outcome: "passed", message: `Flag exists: ${path}` }
        : { outcome: "failed", message: `Flag does not exist: ${path}` };
    },
  }),
];

function runBrief() {
  return {
    title: "Retry or waive a gate",
    description: "Escalate an exhausted gate for investigation, then retry or dismiss it.",
  };
}

// XState's setup interface uses empty runtime values to carry compile-time machine types.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const types = {} as {
  input: z.infer<typeof inputSchema>;
  context: { flag: string; gate: string | null; status: GateStatus | null };
  events:
    | { type: "EXHAUSTED"; data: GateEventData }
    | { type: "CLEARED"; data: GateEventData }
    | { type: "DISMISSED"; data: GateEventData }
    | { type: "RETRY" }
    | { type: "WAIVE" }
    | { type: "DONE" };
};

const machine = setup({ types }).createMachine({
  context: ({ input }) => ({ flag: input.flag, gate: null, status: null }),
  initial: "gate",
  states: {
    gate: {
      meta: {
        title: "Required flag",
        gate: ({ context }: { context: { flag: string } }) => ({
          probe: "flag-exists",
          params: { path: context.flag },
        }),
        on: { exhausted: "EXHAUSTED", cleared: "CLEARED", dismissed: "DISMISSED" },
      },
      on: {
        EXHAUSTED: {
          target: "investigate",
          actions: assign({
            gate: ({ event }) => event.data.gate,
            status: ({ event }) => event.data.status,
          }),
        },
        CLEARED: "finish",
        DISMISSED: "finish",
      },
    },
    investigate: {
      meta: {
        title: "Investigate exhausted gate",
        commands: { retry: "RETRY", waive: "WAIVE" },
        task: ({ context }: { context: { gate: string | null; status: GateStatus | null } }) => ({
          evidence: context.status,
          instructions: `Investigate gate ${context.gate}. For retry, fix the condition and submit retry. For waive, first run \`bl gate clear ${context.gate} --dismiss --reason "Waived after investigation"\`, then submit waive.`,
        }),
      },
      on: { RETRY: "gate", WAIVE: "finish" },
    },
    finish: {
      meta: {
        title: "Record outcome",
        commands: { done: "DONE" },
        task: () => ({ instructions: "Record the gate outcome." }),
      },
      on: { DONE: "done" },
    },
    done: { type: "final" },
  },
});

export const workflow = defineWorkflow({
  name: "gate-escalation",
  version: "1.0.0",
  description: "Investigate an exhausted gate, then retry or waive it.",
  inputSchema,
  commandSchemas,
  machine,
  runBrief,
  probes,
});
