# @botlake/extension-work-gates

Work Gates evaluates trusted named probes and records their results in [Work gates](../work/README.md#gates). Select it explicitly with Identity and Work; importing or installing it does not activate it.

## Define and select a probe

Probe code lives in trusted lake configuration, not in graph data. A gate stores only the probe name, validated parameters and the policy copied at creation.

```ts
import { existsSync } from "node:fs";

import { defineProbe, workGates } from "@botlake/extension-work-gates";
import { z } from "zod";

const fileExists = defineProbe({
  name: "file-exists",
  description: "Wait until a local file exists",
  params: z.object({ path: z.string().min(1) }),
  policy: { everyMs: 30_000, maxAttempts: 5, timeoutMs: 2_000 },
  async run({ path }) {
    return existsSync(path)
      ? { outcome: "passed", message: `Found ${path}` }
      : { outcome: "failed", message: `Waiting for ${path}` };
  },
});

export default workGates({ probes: [fileExists] });
```

`params` is a Zod schema. `run` receives parsed parameters plus `{ signal, gate }`; honour the abort signal when calling APIs that support it. Return `passed` when the condition holds or `failed` when it does not yet hold. A throw, timeout, unknown probe or invalid verdict is recorded as an errored attempt.

The policy is:

- `everyMs`: delay between attempts.
- `maxAttempts`: attempts in one round.
- `timeoutMs`: timeout for each attempt.

## Commands

```sh
bl prime gate
bl gate probes
bl gate create "VPN reaches GitLab" --probe vpn-ready --param host=gitlab.example --dependent TASK
bl gate retry GATE --reason "VPN configuration fixed"
bl gate clear GATE --reason "Verified by another check"
bl gate clear GATE --dismiss --reason "Condition is no longer required"
```

`probes` lists configured probe names, descriptions, parameter schemas and policies. `create` validates the probe and parameters, creates the gate, links every `--dependent` task to it and schedules evaluation. Repeat `--param K=V` and `--dependent TASK` as needed; parameters are JSON-coerced when possible. `--parent GROUP` places the gate in context.

`retry` starts a fresh attempt round for any open gate. `clear` closes an open gate as satisfied by the caller. `clear --dismiss` instead closes it as no longer required. Closed gates are terminal.

## Status and readiness

| Status      | Work state | Meaning                                                         |
| ----------- | ---------- | --------------------------------------------------------------- |
| `pending`   | open       | An attempt is due now.                                          |
| `waiting`   | open       | An attempt failed or errored; the next retry is scheduled.      |
| `exhausted` | open       | The round spent its attempt budget; retry, clear or dismiss it. |
| `cleared`   | closed     | The probe passed or an actor confirmed the condition.           |
| `dismissed` | closed     | An actor declared the condition no longer required.             |

A dependent's readiness uses only the gate's Work state, never its status directly. The three open statuses block dependents; both closed outcomes satisfy the prerequisite. `bl work show GATE` and `bl work diagnose TASK` expose the probe, status, last result and schedule. Gates do not appear in task queues and ordinary Work mutation commands reject them.

Evaluation uses durable Core wakes. Restarting a lake restores missing wakes for pending and waiting gates; closing a gate cancels its wake. Duplicate or late attempts are ignored after Work refuses them as stale or closed.

Verify the packaged CLI and evaluator against a disposable SQLite lake with `bun scripts/work-gates-smoke.ts`.
