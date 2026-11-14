# Mail–Agents

Configured live-agent delivery for [Mail](../mail/README.md). Callers use `bl mail` and Batteries `bl await`; there are no separate wake-up operations.

Compose the exact selected Mail and Agents bindings:

```ts
import { mailAgents } from "@botlake/extension-mail-agents";

import agents from "./agents.ts";
import mail from "./mail.ts";

export default mailAgents({ agents, mail, graceSecs: 300 });
```

Explicitly select this descriptor, those Mail/Agents descriptors, and Agents' prerequisites. Imports activate nothing. Native reporting or verified provider output must establish the recipient's session identity. Notification plugins remain responsible for announcing mail inside running sessions.

## Delivery policy

```text
Mail arrives
  |
  v
Recipient running? -- yes --> Store for its inbox/notification plugin
  |
  no
  v
Normally settled within grace? -- yes --> Admit one session continuation
  |
  no
  v
Undeliverable; sender must decide whether to resend
```

`graceSecs` defaults to 300; zero permits live delivery only. Agents records `agent/stopped-at` when custody settles. Every normally completed continuation gets its own grace window; retry clears the previous invocation's stop time. Failed/cancelled runs are not restarted by Mail. An idle external turn still owns its session; only a recorded session end permits a managed continuation. External-only sessions cannot be launched by this composition.

Mail reconciles unannounced messages at startup and every second, covering mail arriving before or after settlement. Pending messages coalesce into one continuation. Each message can cause at most one wake; previously announced or acknowledged messages do not wake agents. New arrivals can cause a later continuation without enrollment. Admission and the message's `mail/wake-run` marker commit together; Agents owns session custody and continuation exclusion. Resume admission is not notification delivery or execution success.

Mail uses Agents' automatic-continuation admission seam. When Work Auto Bot owns the target lineage, its atomic readiness/assignment/pause checks and shared continuation budget also apply to Mail. Exhausted workers and the one-shot Oracle debugger cannot self-resume through mail. Other lineages retain this grace policy; explicit manual Agents resume is unchanged.

Inactive recipients produce `status: "undeliverable", reason: "recipient_inactive"` in send/reply results. Admission refusals produce `reason: "resume_rejected"` and diagnostic `detail`. A removed resume worktree is a typed admission refusal, including during startup reconciliation; the lake remains available, with no cwd fallback or fresh-session retry. Undeliverable messages leave the live inbox and are never retried automatically; a terminal record remains available to the sender through ordinary Mail reads/lists. Mail accepted while running can become undeliverable later, so use `mail read ID` or `mail-undeliverable` to observe that outcome. No expiry wake, fallback session or retry queue is created.

Bodies never enter the resume prompt. The resumed agent retrieves and acknowledges mail through the ordinary Mail operations. Use Batteries await to remain in the current turn; it does not control automatic wake permission.
