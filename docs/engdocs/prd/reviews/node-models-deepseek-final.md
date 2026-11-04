# DeepSeek model/liveness review — final confirmation

## Verdict

**Blockers resolved.** All five findings are addressed for the supported cases. I found no remaining material issue in the corrected paths. The previously accepted deferred policy (no inactivity timeout; no automatic claim-to-run enrollment; no-end native sessions retain ownership) is unchanged and was not expanded.

## Finding-by-finding confirmation

1. **Delayed managed settlement + retry — resolved.**
   - `extensions/agents/src/liveness.ts:37-55` now interprets a supplied `Node` snapshot.
   - `extensions/work-agents/src/index.ts:284-297` uses the committed `change.after` snapshot only when it says `agentAttributes.settled === true`; all other run changes read the current run via `ctx.graph.show`.
   - `extensions/work-agents/src/index.ts:354-356` still revalidates the current task assignment token/assignee and binding status before release.
   - `scripts/work-agent-smoke.ts:539-563` covers gated settled failure → retry before subscriber delivery, asserts the old assignment is released and the old binding is `released`.
   - The follow-up fresh claim/bind/settlement at `scripts/work-agent-smoke.ts:565-606` confirms the retried invocation can be bound and released.

2. **Stopped/failed but unsettled managed binding — resolved.**
   - `extensions/work-agents/src/index.ts:147-151` now requires registered identity, agent audience, non-null invocation and `!settled`; it no longer requires `state === "running"`.
   - `scripts/work-agent-smoke.ts:608-644` binds after uncertain cancellation, confirms ownership is retained, then settles and confirms release.

3. **Core note-model ownership — resolved.**
   - `packages/core/src/core/store.ts:128-129` no longer seeds immutable note keys with string literals.
   - `packages/core/src/core/store.ts:241-246` calls `declareImmutable` for `Object.values(noteAttributes)` inside the fresh-schema transaction.
   - A focused `/tmp` check against a fresh `Graph(":memory:")` confirmed `note/text` remains protected: `archive(note.id, ["note/text"])` throws `Immutable attribute`.

4. **README relationship precision — resolved.**
   - `extensions/identity/README.md:5,13` now says `recordParticipation`/`performed` covers managed invocations or external sessions.
   - `extensions/work-agents/README.md:17,19` distinguishes managed event/restart checking, external periodic rechecking, and token/invocation versus native-identity fencing.
   - `extensions/workflow/README.md:15` uses a dotted `stored context-group reference` arrow rather than implying a graph edge.
   - Stale-expiry wording is gone from the relevant current policy prose; remaining “stale” references describe fencing, not a timeout.

5. **Partial observation schema naming — resolved.**
   - `extensions/agents/src/node-model.ts:91-94` exports `agentActivityObservationSchema`.
   - `extensions/agents/src/liveness.ts:8,49` and `extensions/agents/src/index.ts:10-18` use/export the renamed schema.
   - No `agentObservationSchema` references remain.
   - `extensions/agents/README.md:152` explicitly says it is the partial activity projection, not the complete stored metadata contract.

## Checks performed

- Inspected the updated liveness, Work Agents observe/check/release/bind paths, core schema initialization, public exports and READMEs.
- Grepped for stale names and obsolete observation/expiry wording.
- Ran `bun scripts/work-agent-smoke.ts` — passed all phases: quiet managed ownership; exit release without hooks; delayed settlement survives retry and rebinding; uncertain custody can bind before settlement; SQLite restart wake; null external heartbeat; quiet native ownership retained; session-end reread releases; fenced release; audience guards; packaged CLI managed cancellation; settled await; matching release only.
- Ran a focused fresh-`Graph` note-immutability check (passed).
- Did not run broad suites; made no repository edits, commits, delegations, or shared-lake restarts. No task completion performed.

## Primary verification

Reviewed 31 October 2026 using the configured DeepSeek Flash seat at max effort. The [initial review](node-models-deepseek.md) records the findings against the earlier candidate; the confirmation above checks their resolution. The primary author reproduced both liveness failures in the smoke before applying their fixes.

After reconciliation, `bun run check`, all 31 blackbox tests, and the expanded Work Agents smoke passed. Six relationship diagrams rendered successfully; the corrected Workflow stored-reference arrow was visually checked. Full suites ran through `qlock` on `/tmp/agent-cpu.lock`.

Optional polish was not treated as a blocker or an instruction to redesign the model. Automatic claim-to-run enrollment and zombie/stalled-work policy remain deferred; explicit assignment binding remains required.
