# @botlake/extension-workflow

Explicitly select Identity and Workflow. There are no built-in workflows and no Kanban dependency. `bl prime workflow` explains the working pattern; help owns command syntax.

## Author

Place trusted TypeScript in `.workflows/NAME/workflow.ts` alongside `workflow.toml`:

```toml
version = "1.0.0"
description = "What this process accomplishes"
run = "workflow.ts"
```

The module retains Busybee's contract: export `machine`, `inputSchema`, `commandSchemas` and `runBrief`; optionally `describe`, `validateCommand` and `inputConstraints`. A titled XState state is work. `meta.task` renders its instructions; `meta.commands` maps choices to events. Commandless titled ancestors become groups. Metadata contains no separate task inventory.

The [parallel](examples/parallel.ts) and [nested-machine](examples/nested-machines.ts) examples preserve Busybee's authored semantics. Install their imports (`xstate`, `zod`) in the workspace. Execution metadata is inert; no agents launch.

## Work

1. `catalog NAME` reveals initial input; `start NAME --input '{...}'` starts the run. Both also accept `--source FILE` instead of a name.
2. `show RUN_ID` returns current task summaries, assignees, blockages and compact decision history. Lists are unpaginated; historical entries contain only ID, title, choice and completion-time assignee.
3. `show TASK_ID` reveals one task's frozen instructions, context and choice schemas. Historical tasks retain original results, assignment history and completion attribution.
4. `claim TASK_ID` records responsibility, defaulting to `BL_ACTOR`; `--owner` hands off explicitly. Assignment is not process custody.
5. `complete TASK_ID CHOICE --data '{...}'` closes work, delivers the parsed outcome, publishes subsequent visits and checkpoints in one transaction. Failure rolls the entire operation back. Matching original-result retries are idempotent.

Groups close automatically. Parallel branches advance independently. Revision loops create fresh visits; completed visits cannot reopen. The run closes only when the machine and all contained work finish. Ordinary graph children and prerequisites remain ordinary graph work; their completion is not another workflow event.

`block RUN_ID|TASK_ID --reason TEXT [--needed-from IDENTITY]` records an operational impediment, independent of graph readiness. `unblock BLOCK_ID --resolution TEXT` resolves exactly one record, preserving attribution and history. Task holds leave siblings available; ancestor holds apply to contained work. Ownership and snapshots remain intact. See the [blockage protocol](../../docs/work-blockages.md).

## Persistence

Named definitions restore only with their exact version and folder fingerprint; explicit files use entry-file fingerprints. Changed already-imported modules require a lake restart. Full XState actor snapshots are stored as JSON strings to replace checkpoints verbatim. No compatibility preflight, migration, cancellation or durable external-effect execution is supplied.

An optional `start --parent NODE` attaches a run as contained work. The separate Workflow-Kanban extension links existing roots; Kanban independently owns its progression policy and blockage presentation.
