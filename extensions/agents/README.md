# @botlake/extension-agents

Headless agent runs with provider routing, resume/retry and process custody.

Install the Core, Identity and Flags peer packages. Explicitly select Identity and Agents in your [lake configuration](../../docs/usage.md#packages-and-extension-selection). Selecting `"@botlake/extension-agents"` gives ungated Codex, Pi and Claude defaults. Imports activate nothing; configuration changes require a lake restart. TypeScript consumers need `skipLibCheck: true` for upstream XState declarations.

## Catalog and routing

For custom routing, select a local Agents module instead. This example also requires explicit selection of its [Flags module](../flags/README.md):

```ts
// flags.ts
import { agentFlags } from "@botlake/extension-agents";
import { configureFlags, flags } from "@botlake/extension-flags";

export const modelFlags = flags({
  openai: { name: "model/openai", description: "Enable OpenAI seats.", default: true },
});

export default configureFlags([
  [agentFlags.claude, false],
  [modelFlags.openai, true],
]);
```

```ts
// agents.ts
import { agents, agentFlags, builtinProviders } from "@botlake/extension-agents";

import { modelFlags } from "./flags.ts";

export default agents({
  providers: [
    builtinProviders.pi(), // Ungated.
    builtinProviders.claude({ flag: agentFlags.claude }),
  ],
  aliases: {
    sol: {
      doc: "Complex implementation and debugging.",
      parent: "pi",
      model: "openai-codex/gpt-5.6-sol",
      effort: "low",
      when: modelFlags.openai.name,
    },
    opus: { parent: "claude", model: "opus" },
    reviewer: [
      { doc: "Prefer Sol for review.", parent: "sol" },
      { doc: "Fallback review.", parent: "opus" },
    ],
  },
});
```

- `providers` is the **complete registry**, not an addition to defaults. Omit it for all three ungated built-ins; `[]` registers none. Duplicate names are errors.
- Any provider `flag` or alias `when` requires Flags selection; otherwise Flags need not activate. Only effective `true` enables a gate; missing/unset is false. `configureFlags` requires explicit booleans, not definition defaults. Persistent overrides survive restart; `bl flag reset NAME` restores the configured default.
- Aliases accept a descriptor, a seat name, or a nonempty ordered candidate array. `parent` names a provider/alias; `{ provider: "pi" }` also works. Nearest model/effort/extraArgs replace inherited values; **systemPrompt never inherits**.
- The first candidate with an available condition and parent chain wins **before launch**. This is neither failure retry nor an installed-model probe. `when` accepts flag names and nested `and`/`or`/`not`, for example `["and", "model/openai", ["not", "maintenance"]]`. Unset flags are false.

```sh
bl agent catalog                  # Available seats, docs and settings.
bl agent catalog --all            # Also show unavailability reasons.
bl agent catalog reviewer        # Expand all candidates.
bl flag set agent/claude true
bl flag set model/openai false    # New reviewer runs now select opus.
```

## Managed run lifecycle

```sh
bl agent start --seat reviewer --cwd "$PWD" \
  --prompt "Review the code; do not edit files."
# Example response while running:
# {"id":"042-apple-cloud","state":"running","substatus":"pending","settled":false}

bl await --query agent-run-settled --params '{"runId":"042-apple-cloud"}' --min-count 1
bl agent show 042-apple-cloud
```

Waiting requires explicitly selected [Batteries](../batteries/README.md). Check `reason: "satisfied"`, then inspect the run; timeout/interruption stops only the wait. Example `agent show` **attribute excerpts**:

```json
{ "agent/state": "stopped", "agent/substatus": "completed", "agent/settled": true }
```

```json
{ "agent/state": "stopped", "agent/substatus": "requested", "agent/settled": false }
```

**Settled custody is not execution success or task completion.** Settlement includes failure/cancellation; `completed` indicates successful execution. Read `agent/result` and `agent/error`. Closed/stopped alone proves neither settlement nor success. Uncertain custody blocks retry and assignment release; inactivity is not exit evidence.

```sh
bl agent list --state failed --limit 10
bl agent retry RUN_ID
bl agent resume RUN_ID "Continue with the next step" --request-id continuation-1
bl agent cancel RUN_ID
bl agent acknowledge RUN_ID
bl agent reconcile
```

| Operation | Contract |
| --- | --- |
| start/retry/resume/cancel | Return `{ id, state, substatus, settled }`. Pending cancellation abandons the run. |
| retry | Same run, new invocation; only settled failures without a served target or request binding. Clears acknowledgement. |
| resume | New run from a settled managed run with a confirmed native session. One accepted continuation per run; no concurrent session writer. |
| acknowledge | Settled custody acknowledgement: `{ id, acknowledged }`, including runs never launched. |
| reconcile | `{ reconciled: true }` means a pass ran, not that custody settled. |
| list | `{ runs, total, nextOffset }`; follow `nextOffset` until null. Default 20, maximum 100; pages are not snapshots. |

Accepted runs freeze resolved settings and prompt text across retry/resume. Flag changes affect new selection only. `--request-id` enables exact replay of the original accepted request, even if its alias is now disabled. External sessions have null substatus/settled and no managed stop authority. Run success never closes its task. `agent/stopped-at` records when custody settled for the invocation, independently of success; retry clears it. Consumers such as Mail calculate their own grace periods from that timestamp.

### Automatic continuation integrations

Typed consumers use `resumeAutomatically(id, prompt, requestId)` for automatic native continuation. It shares `resume`'s session verification, idempotent replay and one-child fence. Domain extensions can register synchronous `guardAutomaticContinuation(parent)` callbacks; they run in the admission transaction before a new automatic continuation. Explicit manual `resume` (including the CLI) does not invoke those policies. `sessionAvailable(id)` reads tracked session-writer custody; idle external turns still own their session.

`recoverLaunch(id, prompt, requestId)` is a narrow automatic fresh-launch path: only settled preparation/launch failures with **no native session** qualify. It creates a new run with frozen settings/cwd and a `continues` edge, but no inherited identity/session. It invokes the same guards and cannot compete with an already accepted resume. Execution/session failures and cancellation do not qualify. This does not loosen generic `retry` or provide a CLI retry bypass. The `continues` relation therefore records both verified session resumption and explicit pre-session launch recovery; `agent/resumes` distinguishes them.

[Work Auto Bot](../work-auto-bot/README.md) supplies its task eligibility and bounded policy through this seam. Agents itself installs no retry loop or Work policy.

## Working across repositories

### Execute elsewhere, keep ownership here

```sh
bl --workspace OWNER agent start --seat reviewer --cwd /path/to/OTHER_REPO \
  --target OWNER_TASK --prompt "Inspect this repo and report findings."
bl --workspace OWNER await --query agent-run-settled --params '{"runId":"RUN_ID"}' --min-count 1
bl --workspace OWNER agent activity peek RUN_ID
```

`--workspace` selects the owner: seats, flags, prompts, custody, results and activity. `--cwd` changes only execution context and its native repository instructions; `OTHER_REPO` needs no lake. Targets must be original tasks in the owning lake, not imported references. Linked Git worktrees normally share their main checkout's lake.

Managed children receive the owner's absolute `BL_WORKSPACE`. Keep it intact: plain `bl`, `botlake lake`/`bin` and native reporting stay at the owner after `cd`. Explicit `--workspace OTHER` addresses another lake without relocating the run or its activity; cross-lake mutations do not create a local managed assignment binding.

### Execute and record at the destination

```sh
bl --workspace DEST agent catalog
bl --workspace DEST agent start --seat reviewer --cwd /path/to/DEST_REPO \
  --target DEST_TASK --prompt "Complete the destination task and report results."
bl --workspace OWNER agent follow RUN_ID --from-workspace DEST
bl --workspace DEST agent show RUN_ID
```

Start `DEST` with its required extensions/seats first. Its configuration applies, including `BL_WORKSPACE=DEST` for the child. For task dependencies, use Work's [cross-lake links](../work/README.md#relationships); remote task closure affects readiness, not coordinator task completion.

Admission rejects a missing cwd or a non-directory parent path component with a typed `cwd` fault. No native session is relocated and no fresh worker is substituted. Automatic consumers such as Mail can report this expected admission refusal without failing lake activation; unexpected filesystem defects still propagate.

Resume, resumable retry and resumed launch reject another tracked writer for the same provider/session. An external session keeps that claim while working, idle or unknown; only a recorded session end releases it. A missing end observation can therefore block resumption after an external process crashes.

## Following another lake's run

Configure `agents({ references: shared })` with an explicitly selected [reference library](../references/README.md) in both lakes. The source library needs `agentReferenceProjections`.

```sh
bl agent follow RUN_ID --from-workspace OWNER
bl agent show LOCAL_REFERENCE_ID
bl --workspace OWNER agent show RUN_ID
```

Follow reuses a local read-only summary with provenance. Updates are eventual and become stale on disconnect. Prompts, results, activity and custody remain source-owned; use the owner's original run ID for waits, retry, resume and cancellation. Followed runs are outside the local run list; their core state is not settlement evidence.

## System prompts

```ts
import { brief as coreBrief } from "@botlake/core";
import { agents, brief as agentBrief, type SessionContext } from "@botlake/extension-agents";

function projectPrompt({ audience, model }: SessionContext): string {
  return [
    audience === "agent"
      ? "Report concise findings to the coordinating agent."
      : "Explain next steps.",
    coreBrief,
    agentBrief,
    model?.startsWith("deepseek/") ? "State acceptance criteria before editing." : "",
  ].join("\n\n");
}

export default agents({
  unmanaged: { systemPrompt: projectPrompt },
  aliases: {
    reviewer: { parent: "pi", systemPrompt: projectPrompt },
    worker: { parent: "reviewer" }, // No system prompt: it does not inherit.
  },
});
```

Prompts accept strings or synchronous callbacks. Context contains `provider`, `model`, `effort`, `seat`, `audience`, `cwd` and `workspace`; unknown model/effort/seat are null. Callbacks run after settings resolve, not during catalog inspection (`{ "dynamic": true }`). Only the selected candidate's explicit prompt applies; omission/`""` adds none.

Managed audience is always `agent`; launches scrub inherited `BL_AUDIENCE` and `BL_ACTOR`, restoring established identity only for verified resumes. Direct native sessions may use `BL_AUDIENCE=human pi` or `BL_AUDIENCE=agent pi`; absence means `unknown`. Do not export this globally: other subprocesses can inherit it. Audience describes the recipient, not UI presence.

Unmanaged sessions receive only `unmanaged.systemPrompt` through native reporting and a reachable lake: Pi refreshes each turn, Claude/Codex at startup. Managed runs never receive it. Identity/task guidance and the host's base prompt remain separate.

## Provider strategies

```ts
import { agents, builtinProviders } from "@botlake/extension-agents";

export default agents({
  providers: [
    builtinProviders.claude({ bin: "claude-wrapper" }), // Your wrapper on PATH.
    builtinProviders.codex(),
    builtinProviders.pi(),
  ],
});
```

Each factory accepts either `bin?: string` for one executable resolved normally via PATH, or `command: readonly [string, ...string[]]` for a full argv prefix, such as `["bun", "/path/to/wrapper.ts"]`. They are mutually exclusive; omitting both keeps the usual built-in executable. Optional `flag` is independent and accepts your own `FlagDefinition`. The wrapper must preserve the host's JSON/print protocol. Argument order is prefix, provider protocol, run `extraArgs`, generated model/effort/prompt, then resume arguments.

A custom `Provider` supplies a unique `name`, `doc`, optional `flag`, and:

- `prepare(run)` → `{ command: string[], stdin: string, env: Record<string, string> }`.
- `finish(run, exitCode, stdout, stderr)` → `{ success, result, sessionId, error }`; the latter three values are strings or null.

Those methods permit execution; an observed output `sessionId` can bind identity after exit. Full in-session identity/activity or unmanaged observation requires **harness-native reporting**, not necessarily a separate plugin artifact.

## Run activity

```sh
bl agent activity peek RUN_ID
bl agent activity peek IDENTITY_NAME
bl agent activity list ACTIVITY_HANDLE --limit 20
bl agent activity list ACTIVITY_HANDLE --after NEXT_CURSOR
bl agent activity search "VPN access" --target RUN_ID
```

Equivalent structured request, with an example empty search response:

```sh
bl --input '{"command":"activity","operation":"search","query":"VPN access","after":0,"limit":20}' agent
# {"stream":null,"events":[],"nextCursor":null}
```

A run selects its current invocation, an identity its latest stream, and a handle that exact stream. Omit the list/search target for all retained events. `nextCursor` is a received sequence, not time/offset. Peek bounds recent events, outstanding tool starts and scoped usage; observations prove neither progress nor liveness.

Optional native reporting supplies turn/tool events and visible excerpts capped at 2,048 characters (`truncated` marks clipping). Tool output/reasoning stay in the native transcript, referenced by `sessionId`/`sessionPath` when available. Stdout results are not an activity feed. Native subagents appear only as caller tool events. Pi reports harness-supplied usage/cost; Claude/Codex currently do not. Unknown values stay null; peek does not sum cumulative and incremental usage.

```ts
agents({ activity: { retentionMs: 7 * 24 * 60 * 60 * 1000 } }); // Default: seven days.
```

Retention starts at managed settlement or external session end, never mere quiet. Expiry removes events/search entries but retains a tombstone with dates, count and native reference. Late observations cannot repopulate it.

## Native integration

The private, repository-local [native plugin](../../plugins/identity/README.md) hardcodes `claude`, `codex` and `pi` namespaces. Same-namespace executable wrappers can reuse it; use aliases for named variants. Custom callbacks must match their provider's namespace. Nothing installs automatically; this is not a published plugin SDK.

`agent/integration` is `unobserved`, `native` or `output`. Missing hooks do not fail otherwise successful managed execution. Output-based identity does not fabricate activity or model metadata; direct/unmanaged observation requires native reporting. Native sessions supply their own IDs—Botlake does not allocate fresh ones.
