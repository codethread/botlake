# @botlake/extension-work-auto-bot

Explicitly configure Work Auto Bot with the exact Work and Agents runtime bindings selected in the lake (alongside their Identity/Flags prerequisites). Imports are inert; there is no zero-argument default because same-name bindings are not interchangeable. Nothing opts in by default. No separate daemon or model fallback is installed.

```ts
import { workAutoBot } from "@botlake/extension-work-auto-bot";

import agents from "./agents.ts";
import work from "./work.ts";

export default workAutoBot({ agents, work });
```

The factory derives `requires` from `agents.name` and `work.name`, then resolves those same objects during activation.

Set these task attributes through Core/Batteries:

| Attribute                | Value                                                                 |
| ------------------------ | --------------------------------------------------------------------- |
| `work-auto-bot/auto-run` | Boolean `true` to opt in; strings do not opt in.                      |
| `work-auto-bot/seat`     | Required available Agents seat/alias.                                 |
| `work-auto-bot/cwd`      | Optional absolute directory; defaults to the owning lake's workspace. |

```sh
bl node update TASK --attributes '{"work-auto-bot/auto-run":true,"work-auto-bot/seat":"worker"}'
```

On startup and every second, only owned, open, ready, unassigned AFK tasks are admitted as managed Agents targets. References, groups, gates, HITL and waiting work never launch. Agents enforces existing-writer/custody protections. The short worker prompt asks it to claim the exact task, resolve blockers proactively, seek Oracle counsel for conflicting blockers, and, if still blocked, create an unplanned HITL prerequisite, release its exact assignment and stop. Successful work submits its authored Workflow outcome when applicable, otherwise closes the satisfied task. This is worker guidance, not automatic task closure on process exit.

Each task gets **at most one automatic admission**, retained in Agents history under request ID `work-auto-bot/TASK`. Polls, restarts, task reopening and worker settlement never automatically admit it again. Keep that history. Inspect the managed run with `bl agent show RUN`. To continue a settled run with a verified native session, explicitly use `bl agent resume RUN --prompt TEXT`. Agents' `retry` applies only to settled, unassigned failures without a request binding: automatic runs are request/target-bound, so recovery without a resumable session requires an explicit `agent start --target TASK --seat SEAT --cwd DIR --prompt TEXT`. Neither path is automatic.

Unavailable or unknown seats and existing active writers are skipped; first admission remains possible when the seat becomes available or the writer settles. Malformed task settings (such as a missing/non-string seat or invalid cwd) and other admission errors persist `work-auto-bot/error` on the task and stop further attempts. Inspect with `bl node show TASK`. After correcting the cause, explicitly clear the error to allow a first admission:

```sh
bl node update TASK --attributes '{"work-auto-bot/error":null}'
```

Selecting [Work Agents](../work-agents/README.md) additionally releases matching worker assignments on confirmed settlement. Without it, interrupted workers' assignments require explicit token-fenced release.

`bun scripts/work-auto-bot-smoke.ts` checks disposable SQLite admission, rejection, restart, settlement and packaged selection with deterministic provider/process fixtures; no live model calls.
