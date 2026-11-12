# Mail–Agents

Optional one-shot continuation for an explicitly waiting managed agent. Core Mail still works without Agents. This composition uses the exact configured `RuntimeExtension<Agents>` binding and delegates session custody and continuation exclusion to `Agents.resume`.

Configure Agents once, then import that same binding into a separately selected module:

```ts
// .botlake/mail-agents.ts
import { mailAgents } from "@botlake/extension-mail-agents";

import agents from "./agents.ts";

export default mailAgents({ agents });
```

Explicitly select Mail, this module, the Agents module and its Identity/Flags prerequisites. The native Identity plugin must register the running session before it can arm a wait. The Mail plugin is optional for resumption: this extension observes pending graph mail independently of notification delivery state.

## Agent workflow

Use `bl prime mail-agent` for the policy. While a managed run is still executing with a verified identity:

```sh
bl --identity YOUR_ID mail-agent arm RUN_ID --timeout-secs 300
```

`RUN_ID` is the part of `BL_RUN_REFERENCE` before the colon. The result contains a wait ID, status and absolute expiry. Acknowledge seen mail before arming; already-pending unacknowledged messages qualify too. Arming does not suspend or stop the process: end the turn normally when the task is waiting. This is attribution-scoped, not authentication.

After normal process completion and custody settlement, pending mail admits one continuation of the same verified native session. Several messages coalesce into that continuation; resumption does not acknowledge messages or mark them delivered. A resumed agent must arm its new run explicitly if it needs another continuation. Generic `bl await` remains the way to wait inside the current turn.

```sh
bl --identity YOUR_ID mail-agent show WAIT_ID
bl --identity YOUR_ID mail-agent cancel WAIT_ID
```

Cancel before finishing a task if its permission is still armed. Repeating arm for the same running invocation returns its original record without extending its deadline; a terminal permission cannot be rearmed within that invocation. A manually retried run may explicitly arm its new invocation; it never inherits the prior permission. Cancellation revokes only an unconsumed permission, never an admitted or running continuation. Use the Agents cancellation operation for process custody.

## Outcomes and recovery

Waits are durable graph records with `armed`, `resumed`, `expired`, `cancelled` or `failed` state. Default lifetime is 300 seconds, maximum 86400. Expiration does not wake a session. Scan runs on resource startup and every second, checking both settlement/mail arrival orders. Admission and permission consumption commit in one graph transaction with a deterministic request ID. Restarts cannot duplicate accepted continuations.

Cancelled/failed agent runs are not resumed. A changed identity or invocation invalidates permission. Agents rejects completed task targets, pre-existing continuations and another active writer for the native session. An external session must have a recorded session end; an idle turn or missing end observation does not release its claim. Rejections remain visible as `failed` with an error; there is no automatic retry or fallback session. `resumed` records admission, not execution success: inspect its `continuation` through `agent show` or `agent-run-settled`.

The `mail-agent-wait-settled` query accepts `{id: WAIT_ID}` and matches any terminal permission state. It does not prove successful resumption or task completion. Bodies never enter the resume prompt; the agent retrieves them through Mail.
