import { fromPromise, setup } from "xstate";
import { z } from "zod";

const text = z.string().trim().min(1);

export const inputSchema = z.strictObject({
  checksFile: text,
  controlUrl: z.url(),
  workspace: text,
});
export const commandSchemas = {
  continue: z.object({}),
  done: z.object({}),
  merge: z.object({}),
};

interface WorkflowInput {
  checksFile: string;
  controlUrl: string;
  workspace: string;
}

const bunChecks = fromPromise<{ code: number }, WorkflowInput>(({ input, signal }) =>
  runBunChecks(input, signal),
);

const controlledCi = fromPromise(
  async ({ input, signal }: { input: WorkflowInput; signal: AbortSignal }) => {
    const response = await fetch(new URL("/ci", input.controlUrl), { signal });
    if (!response.ok) throw new Error(`Controlled CI failed: ${response.status}`);
    return response.json();
  },
);

const controlledChild = fromPromise(
  async ({ input, signal }: { input: WorkflowInput; signal: AbortSignal }) => {
    const response = await fetch(new URL("/child", input.controlUrl), { signal });
    if (!response.ok) throw new Error(`Controlled child action failed: ${response.status}`);
    return response.json();
  },
);

export function runBrief() {
  return {
    title: "Implement to merge",
    description: "Implement, check, raise a PR, wait for CI and merge using native invocations.",
  };
}

export const machine = setup({
  // oxlint-disable-next-line typescript/no-unnecessary-type-assertion, typescript/no-unsafe-type-assertion
  types: {} as { context: WorkflowInput; input: WorkflowInput },
  actors: { bunChecks, controlledCi },
}).createMachine({
  id: "invocation-pipeline",
  context: ({ input }) => input,
  initial: "implement",
  states: {
    implement: {
      meta: {
        title: "Implement change",
        commands: { done: "IMPLEMENTED" },
        task: () => ({ instructions: "Implement the requested change." }),
      },
      on: { IMPLEMENTED: "checks" },
    },
    checks: {
      invoke: {
        id: "bun-checks",
        src: "bunChecks",
        input: ({ context }) => context,
        onDone: "raisePr",
        onError: "checksFailed",
      },
    },
    checksFailed: {
      meta: {
        title: "Repair failed checks",
        commands: { done: "REPAIRED" },
        task: () => ({ instructions: "Repair the failed Bun checks." }),
      },
      on: { REPAIRED: "checks" },
    },
    raisePr: {
      meta: {
        title: "Raise PR",
        commands: { done: "PR_RAISED" },
        task: () => ({ instructions: "Open a pull request for the implementation." }),
      },
      on: { PR_RAISED: "ci" },
    },
    ci: {
      invoke: {
        id: "controlled-ci",
        src: "controlledCi",
        input: ({ context }) => context,
        onDone: "mergePr",
        onError: "ciFailed",
      },
    },
    ciFailed: {
      meta: {
        title: "Resolve CI failure",
        commands: { done: "CI_FIXED" },
        task: () => ({ instructions: "Resolve the failed CI run and retry." }),
      },
      on: { CI_FIXED: "ci" },
    },
    mergePr: {
      meta: {
        title: "Merge PR",
        commands: { merge: "MERGED" },
        task: () => ({ instructions: "Merge the pull request after CI passes." }),
      },
      on: { MERGED: "done" },
    },
    done: { type: "final" },
  },
});

const childWork = setup({
  // oxlint-disable-next-line typescript/no-unnecessary-type-assertion, typescript/no-unsafe-type-assertion
  types: {} as { context: WorkflowInput; input: WorkflowInput },
  actors: { controlledChild },
}).createMachine({
  id: "native-async-child",
  context: ({ input }) => input,
  initial: "prepare",
  states: {
    prepare: {
      meta: {
        title: "Prepare child action",
        commands: { continue: "CONTINUE" },
        task: () => ({ instructions: "Start the native child-machine async action." }),
      },
      on: { CONTINUE: "waiting" },
    },
    waiting: {
      invoke: {
        id: "child-async-action",
        src: "controlledChild",
        input: ({ context }) => context,
        onDone: "published",
        onError: "failed",
      },
    },
    published: {
      meta: {
        title: "Child async result",
        commands: { done: "CHILD_DONE" },
        task: () => ({ instructions: "Confirm the child-machine async result." }),
      },
      on: { CHILD_DONE: "done" },
    },
    failed: {
      meta: {
        title: "Child onError route",
        commands: { done: "CHILD_DONE" },
        task: () => ({ instructions: "Handle the child-machine promise rejection." }),
      },
      on: { CHILD_DONE: "done" },
    },
    done: { type: "final" },
  },
});

export const nativeChildMachine = setup({
  // oxlint-disable-next-line typescript/no-unnecessary-type-assertion, typescript/no-unsafe-type-assertion
  types: {} as { context: WorkflowInput; input: WorkflowInput },
  actors: { childWork },
}).createMachine({
  id: "native-child-invocation",
  context: ({ input }) => input,
  initial: "working",
  states: {
    working: {
      invoke: {
        id: "native-child",
        src: "childWork",
        input: ({ context }) => context,
        onDone: "done",
      },
    },
    done: { type: "final" },
  },
});

// --- Live subprocess adapter ---

async function runBunChecks(input: WorkflowInput, signal: AbortSignal): Promise<{ code: number }> {
  const child = Bun.spawn(["bun", "test", input.checksFile], {
    cwd: input.workspace,
    env: { ...process.env, BOTLAKE_CONTROL_URL: input.controlUrl },
    stderr: "pipe",
    stdout: "pipe",
  });
  const abort = () => {
    child.kill();
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (code !== 0) throw new Error(`bun test failed (${code})\n${stdout}\n${stderr}`);
    return { code };
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
