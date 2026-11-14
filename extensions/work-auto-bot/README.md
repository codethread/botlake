# @botlake/extension-work-auto-bot

Explicit opt-in dispatch and bounded recovery of unfinished Work tasks. No Hub watchdog, separate daemon or activity-silence timer is installed. Imports activate nothing.

Configure the exact Work and Agents bindings selected in the lake, alongside their prerequisites:

```ts
import { workAutoBot } from "@botlake/extension-work-auto-bot";

import agents from "./agents.ts";
import work from "./work.ts";

export default workAutoBot({ agents, work });
```

The factory derives `requires` from those bindings. Configure an available `oracle` seat for terminal debugging; there is no fallback model.

## Opt in and pause

| Task attribute | Value |
| --- | --- |
| `work-auto-bot/auto-run` | Boolean `true` to opt in; `false` intentionally pauses automatic recovery, including Mail continuations of this lineage. |
| `work-auto-bot/seat` | Required available Agents seat/alias. |
| `work-auto-bot/cwd` | Optional absolute directory for initial admission; defaults to the owning lake workspace. |

```sh
bl node update TASK --attributes '{"work-auto-bot/auto-run":true,"work-auto-bot/seat":"worker"}'
bl node update TASK --attributes '{"work-auto-bot/auto-run":false}'
```

On startup and every second, admission atomically rechecks that the task is local, open, graph-ready, unassigned, AFK and opted in. References, groups, gates, HITL, blocked/assigned work and active writers never launch. Seats and provider flags must be enabled. [Work Agents](../work-agents/README.md), when selected, releases the exact worker assignment on confirmed settlement; without it, assignments require explicit token-fenced release.

Workers re-read the current brief/blockers and claim the exact task. A resumed native identity does **not** retain its released assignment. Prompts do not assume interruption: a previous run may have ended normally with unfinished work. Machine waits use Work gates; human-only input is a last resort after diagnosis. Intentional pauses should set `auto-run` false before stopping.

## Recovery budget

```text
Eligible task
  |
  +-- No automatic admission yet --> Admit initial worker
  |
  +-- Unsettled / cancelled / paused / blocked --> No launch
  |
  +-- Settled unfinished lineage, budget left
  |     +-- Verified session --> Resume
  |     +-- Preparation/launch failure, no session --> Fresh continuation
  |     +-- Other missing session --> Exhaust early
  |
  +-- Three continuations spent --> Exhaust
                                    |
                                    +-- One Oracle debugger admission
                                    +-- Then explicit manual recovery only
```

The initial request is `work-auto-bot/TASK`. Up to **three continuations after initial admission** are derived from Agents' existing `continues` chain, not a second counter or observation ledger. All descendants count conservatively, including Mail and manual continuations; manual intervention cannot replenish the automatic budget. Keep run history. Polling, restart and task reopening do not reset it.

Automatic recovery prefers `Agents.resumeAutomatically`, using the existing verified session, identity, frozen settings and original cwd. A changed task cwd does not relocate a retained session. Only confirmed `preparationFailed`/`launchFailed` custody **without a session** permits `Agents.recoverLaunch`: a fresh identity/session, a new run and the same continuation edge/budget. Generic `agent retry` remains restricted to unbound failures. Other missing-session failures exhaust early instead of risking another fresh worker.

Stopped-but-unsettled runs, quiet activity and external sessions without an end observation never prove recovery eligibility. Explicit cancellation or abandonment anywhere in the lineage prevents further automatic recovery. Agents' one-child/session-writer fence and atomic automatic-continuation guards arbitrate with [Mail Agents](../mail-agents/README.md); Mail cannot bypass readiness, pause, assignment or the budget. Non-auto-run lineages keep their existing Mail policy. Explicit manual `agent resume` remains available under Agents' ordinary custody protections.

## Exhaustion and errors

Exhaustion persists `work-auto-bot/exhausted` and appends an actionable note visible in `bl work show TASK`. The `work-auto-bot-exhausted` query also finds exhausted tasks. Like an exhausted gate, it is terminal for automation, not success or automatic task closure.

One Oracle debugger request, `work-auto-bot/TASK/oracle`, serves the original task from the **owning lake workspace**. This distinct fresh debugger receives the failed worker's retained cwd/run in its prompt so it can diagnose even a deleted worker worktree; the worker's native session is never relocated. Its prompt requires proactive investigation/fixes, gates for machine waits, evidence and an explicit next actor before stopping. HITL prerequisites are only for remaining human-only input after diagnosis. It must not reset the budget or arrange replacement workers/self-retries.

Oracle has **one admission, no automatic continuations**, including through Mail. Failed preparation/execution, cancellation, absent session or unfinished normal settlement requires explicit manual diagnosis/recovery. Notes identify the run to inspect; its existing Agents history remains the custody/result authority. If the Oracle seat or owning lake workspace is unavailable, the failed admission is latched visibly; repair it and explicitly start a debugger. No stale timer or automatic Oracle retry is created.

Malformed settings and initial admission failures persist `work-auto-bot/error`; active writers and temporarily disabled worker seats pause all automatic admission, including Oracle escalation. A rejected continuation exhausts early into the same one-shot Oracle path. If the worker worktree is missing, the native continuation fails and the distinct Oracle diagnoses from the owning workspace. An unavailable owning workspace prevents Oracle admission and records repair/manual-recovery instructions. After fixing an initial admission error, clear it explicitly:

```sh
bl node show TASK
bl agent show RUN
bl node update TASK --attributes '{"work-auto-bot/error":null}'
bl agent resume RUN 'Re-read the task and blockers; claim the exact task and continue'
```

Clearing an error does not remove exhaustion or replenish history. Explicit fresh recovery without a resumable session uses `agent start --target TASK --seat SEAT --cwd DIR --prompt TEXT`. Manual recovery never implies that the task is satisfied.

`bun scripts/work-auto-bot-smoke.ts` verifies disposable SQLite custody/readiness, Mail arbitration, pauses/cancellations, bounded continuation, one-shot Oracle, manual recovery, worktree failures and packed CLI restart behavior without live model calls. It is retained in the blackbox suite.
