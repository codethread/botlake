# DeepSeek model/liveness review — botlake-workflows-spike

## Verdict

**Ready with caveats.** The per-extension node model and public package seams are a real improvement in ownership and discoverability. The direct liveness paths are conservative and I found no false-release path in normal operation. However, finding 1 is a concrete fail-to-release (and stuck binding) in a supported retry path, and finding 2 is a second fail-to-release guard. Do not present automatic release as complete until 1 is fixed and 2 is fixed or explicitly accepted/documented.

## Findings (prioritized)

### 1. Delayed managed settlement + retry loses the release and leaves an active stale binding

**Evidence**

- `extensions/work-agents/src/index.ts:284-297` — `observe` reads the current run when the queued subscriber eventually runs.
- `extensions/work-agents/src/index.ts:332-341` — release requires `currentInvocation(...)` and current settled evidence.
- `extensions/work-agents/src/index.ts:219-220` — a still-active binding blocks rebinding the same task.
- `extensions/agents/src/runs.ts:163-198` — `agent retry` is allowed on a settled failure and resets `agent/settled` to false and `agent/invocation` to null; the next `begin` installs a new invocation.
- `packages/core/src/runtime/runtime.ts:382-391` — each event subscriber is awaited on a serial queue; an async subscriber can delay later subscribers while another operation commits.

**Trigger** Start a managed run without `--target`, register native identity, claim a Work task, bind it, make the run fail and settle while a subscriber delays the run event, then `agent retry` before the queue reaches Work Agents. Release the gate. Work Agents rereads the now-running retry, sees the old binding invocation is stale, and does nothing. The assignment stays current with `release: null`; the binding stays `active`; rebinding fails with “Current assignment is already bound”.

I reproduced this with a focused `/tmp` Runtime script using the same gate pattern as `scripts/work-agent-smoke.ts`.

**Recommendation** Process managed **settlement** from the committed `change.after` run snapshot (matching the bound invocation), then re-read the current binding and Work assignment for status/token fencing. Keep the current-state re-read for external session-end, where it is the conservative choice. Add the gate + settlement + retry case to `scripts/work-agent-smoke.ts`.

### 2. A stopped/failed but unsettled managed run cannot be bound, so later settlement cannot release

**Evidence**

- `extensions/work-agents/src/index.ts:137-151` — managed bind requires `state === "running"`.
- `extensions/agents/src/liveness.ts:25-27` — settled custody, not state or silence, is the release evidence; a stopped-but-uncertain run is explicitly insufficient.
- `extensions/agents/src/runs.ts:449-459` and `:463-470` — reconcile can leave `stopped`/`failed` with `settled:false` and a stable invocation.

**Trigger** A managed run is cancelled with uncertain custody before the operator binds. `work-agent bind` throws “Binding requires a running managed invocation”. If custody settles later, no binding exists to release the assignment. I confirmed this with a focused `/tmp` script (`stopped/false/<invocation>` → bind rejected).

**Recommendation** For managed bindings, require a non-null invocation and `!settled`; allow any non-settled lifecycle state. Release still depends only on `settled`. Add this case to the smoke. If intentionally rejected, document “bind before cancellation; manual release otherwise”, because the current README promises settlement release.

### 3. Core’s note model is not the single owner: the DDL still hardcodes note keys

**Evidence**

- `packages/core/src/core/node-model.ts:1-7` — `noteAttributes.text` / `.at`.
- `packages/core/src/core/store.ts:128-129` — `INSERT INTO immutable_keys VALUES ('note/text'), ('note/at')`.
- `packages/core/src/core/store.ts:719-733` — the writer now uses the model constants.

**Trigger** Renaming or adding a note key updates the writer/model but not the DDL immutable-key seed. The old key remains protected and the new key is archivable; Diary’s note text/timestamp immutability can silently diverge. No current runtime difference.

**Recommendation** Seed `immutable_keys` from `Object.values(noteAttributes)` with parameterized `INSERT OR IGNORE`, or call `declareImmutable` for each note attribute. Keep the rest of the model as is.

### 4. README relationship claims are mostly right, but three are imprecise

**Evidence**

- `extensions/identity/README.md:5,13` says `recordParticipation`/`performed` links a _managed_ invocation/run. `extensions/agents/src/native.ts:99-104` also calls it for external runs with `"external"`.
- `extensions/work-agents/README.md:17,19` says both release paths fence on token **and invocation**, and that silence causes periodic rechecking. External bindings store `invocation:null` (`work-agents/src/index.ts:144-147`) and are the only ones scheduled (`:154-166`); managed bindings cancel wakes.
- `extensions/workflow/README.md:15` draws `Run --> Context : context-group`; the code stores `workflow/context-group` as an attribute (`extensions/workflow/src/engine.ts:123-127`), not an edge. The prose is right; the UML arrow is not.

**Recommendation** Identity: “managed invocation or external session.” Work Agents: “Both paths fence on the assignment token; managed also on invocation, external on run/native identity. External bindings are rechecked; managed bindings rely on run events/restart.” Workflow: mark `context-group` as a stored reference (dashed/annotated arrow or note).

### 5. `agentObservationSchema` is a partial liveness projection named like the full stored observation

**Evidence**

- `extensions/agents/src/node-model.ts:91-94` validates only `{ at, activity }`.
- `extensions/agents/src/native.ts:80-94` stores event, audience, seat, model, thinking level, cwd and capabilities.
- `extensions/agents/src/index.ts:10-16` exports it; `extensions/agents/src/liveness.ts:36-46` uses it and strips the rest; `extensions/agents/README.md:152` calls it an activity schema.

**Trigger** A consumer parses stored `agent/observation` with `agentObservationSchema` and silently loses metadata (Zod object strips unknown keys) or treats it as the storage contract. No runtime bug today.

**Recommendation** Rename it to `agentLivenessObservationSchema`/`agentActivityObservationSchema`, or define the full stored observation schema and derive the projection with `.pick({ at: true, activity: true })`.

## Optional polish (not blockers)

- `workflow/private` is written (`workflow/src/engine.ts:125`) but never read. Use it in a query/read path or drop it; “less is more”.
- `work-agent bind` on an already-`ended` external run currently succeeds and releases immediately because `boundRun` does not reject ended observations. Reject ended at bind and/or return binding status in the acknowledgement; this is a contract/UX issue, not a false release of a live holder.
- Work Agents README should mention that Flags is a transitive prerequisite through Agents.
- `noteRelations` and some namespace exports have no current external consumer; keep only if they are intended public API. No central registry is needed.
- Batteries’ `parent-of`/`depends-on` literals and core’s bootstrap relation names in the DDL are accepted: Batteries deliberately owns no attribute model, and the core DDL predates this refactor.

## Accepted tradeoffs / deferred

- No automatic claim-to-run enrollment; manual `work-agent bind` remains explicit.
- No inactivity deadline. Missing external end, crashed native roots, and external child sessions that only report `agent-end` (Codex/Claude SubagentStop) keep ownership. This is consistent with “silence does not prove death”, but external child bindings can hold assignments indefinitely and need an operational answer later.
- Manual bind trusts the caller; no `serves` requirement. Token/invocation fencing prevents stale observations, not choosing the wrong run of the same identity.
- Zombie/stalled-work policy remains deferred.
- Group closure/group prerequisites and D1–D5 remain as approved; not reopened.

## What is good

- One model per owning extension; no central registry or taxonomy. Cross-package consumers use public exports and declared peer dependencies; persisted strings are unchanged; Symbols remain only for mutation authority.
- Work Agents asks Agents for liveness; it does not query Identity activity or process custody directly. Managed settlement and external session-end remain distinct. Token/assignment fencing is correct for the current holder. A quiet run or idle native activity does not release.
- Workflow’s private execution edges (`workflow-member`, `workflow-active`) are correctly separated from Work context (`parent-of`) in code; the README prose reflects this.
- Identity/run/Work/Work Agents ownership is cleanly split: Identity attribution, Agents run evidence, Work assignment ledger, Work Agents private binding/release decision.

## Checks performed

- Read `AGENTS.md`, robustness, TypeScript and codebase-design skills; ran `bl prime kanban`.
- Inspected all node-model files, liveness, Work Agents, Agents run/native paths, Identity, Work store/types, Workflow engine/frontier, core note/store, relevant READMEs, package exports and peer dependencies.
- Grepped for remaining attribute/relation literals and export usage.
- Ran two focused `/tmp` repro scripts: delayed settlement + retry (confirmed finding 1), and uncertain-cancel bind rejection (confirmed finding 2). No repository edits, commits, delegation, or shared-lake restarts.
- Did not rerun the full check, 31 blackbox tests, or the three smokes; no broad failure was suspected and the candidate’s stated baseline was accepted.
