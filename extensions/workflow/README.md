# @botlake/extension-workflow

Select Identity, Work and Workflow explicitly. Imports are inert; `workflows()` is the configured extension. There are no built-in workflows or automatic agent launches.

## Author

Place trusted TypeScript in `.workflows/NAME/workflow.ts` alongside `workflow.toml`:

```toml
version = "1.0.0"
description = "What this process accomplishes"
run = "workflow.ts"
```

Export `machine`, `inputSchema`, `commandSchemas` and `runBrief`; optionally `describe`, `validateCommand` and `inputConstraints`. `runBrief` returns the title and description of the run's Work context group.

Author ordinary XState machines. Use `setup({ actors })` or `.provide({ actors })` for implementations, `invoke` for async work, and native events, guards, `onDone` and `onError` for transitions. Each run owns one live actor system in the lake worker. Promise invocations continue after a CLI command returns; their transitions publish subsequent Work automatically.

Metadata labels project states into Work:

```ts
implement: {
  meta: {
    title: "Implement change",
    task: () => ({ instructions: "Implement and commit the change." }),
    commands: { done: "IMPLEMENTED" },
  },
  on: { IMPLEMENTED: "checks" },
},
checks: {
  invoke: {
    id: "bun-checks",
    src: "bunChecks",
    input: ({ context }) => context,
    onDone: "raisePr",
    onError: "repairChecks",
  },
},
```

A titled state with commands publishes a task. A titled state without commands publishes a context group. `task` renders instructions and optional acceptanceCriteria, notes, assignee, audience, origin and priority; Work applies its usual defaults. Untitled states and non-machine actors publish no Work. There is no workflow probe registry or gate metadata: private checks are ordinary invocations.

While an invocation runs, the workflow can be `waiting` with no actionable tasks. `workflow show` includes the native state value, non-machine child actors and execution errors. Promise actors report lifecycle, not automatic progress logs. Catch expected failures with XState `onError`; unhandled actor or projection errors halt the run and remain visible as `failed`.

See [native invocations](examples/native-invokes.ts), [parallel branches](examples/parallel.ts) and [nested machines](examples/nested-machines.ts). Nested machine Work inherits the nearest context group around its invoking state; no special child input is needed. Parallel events retain XState's normal scope—use distinct events when only one branch should advance. Install authored imports such as `xstate` and `zod` in the workspace.

## Work

```sh
bl prime workflow
bl workflow catalog NAME
bl workflow start NAME --input '{}'
bl workflow show RUN_ID
bl work show TASK_ID
bl work claim TASK_ID
bl workflow complete TASK_ID CHOICE --data '{}'
```

Catalog and start also accept `--source FILE`. `start --parent GROUP` nests the run's context group under an existing open Work group. The execution record is not a Work item: `workflow-member` retains published visits and `workflow-active` identifies the current projection independently of contextual containment.

`complete` validates the choice, payload, prerequisites and Work criteria, then sends the authored event to the live actor that owns the task. Its graph writes—closure, result, checkpoint and subsequent Work—commit together. Repeating the same original choice and raw payload is idempotent; a conflicting retry fails. Generic `work close` and agent-run closure never send workflow events. Closed-but-unconsumed visits remain available for an explicit workflow action.

Revisiting a completed task publishes a fresh task and retains the earlier result. Leaving a state through another XState transition detaches its visit but does not silently close unfinished Work. Execution can therefore finish while follow-up Work keeps the context group open. An enclosing business group never closes automatically.

Run task/history pages default to 20 entries, maximum 100. Continue with `taskPage.nextOffset` or `historyPage.nextOffset`; pages are not snapshots. Task inspection includes frozen instructions, choice schemas, original result and shared Work detail/history.

## Persistence

Every settled actor-system change checkpoints XState's persisted snapshot and reconciles the Work projection. Lake shutdown stops live actors. Activation restores open, nonfailed runs using the exact saved definition: named definitions require their original version and folder fingerprint; file definitions require the entry-file fingerprint. Already-imported source changes require a lake restart. A restore error fails that run visibly without restarting it with different code.

Restoration follows XState semantics, not durable JavaScript continuation. **An unfinished promise runs again after restart.** Effects must tolerate re-execution; there is no exactly-once I/O, durable timer service or transactional rollback of external effects. Honour XState's abort signal, including terminating subprocesses when appropriate.

If projection fails after an event, graph writes roll back but XState actions may already have run. The engine stops and records the failure instead of restoring an earlier actor and replaying effects. Failed runs do not automatically resume. There is no migration, cancellation/replanning or implicit approval/merge policy.

Verify packaged CLIs and disposable SQLite lakes with `bun scripts/workflow-smoke.ts` and `bun scripts/workflow-invokes-smoke.ts`.
