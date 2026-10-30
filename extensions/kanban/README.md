# @botlake/extension-kanban

Boards, cards/tasks, ownership and linked cards. Install the Core and Identity peers and explicitly select both Identity and Kanban. Imports are inert; `kanban()` and `Kanban` are the programmatic interface. Batteries and Agents are not dependencies.

```sh
bl prime kanban
bl kanban add "Investigate issue" --lane refinement --body "Problem, outcome and scope"
bl kanban update ID --acceptance "Observable success criteria" --lane pending
bl kanban claim ID --branch topic
bl kanban block ID --reason "Waiting for access" --needed-from IDENTITY
bl kanban unblock BLOCK_ID --resolution "Access granted"
bl kanban update ID --summary "Decision, verification and next action" --expected-revision REVISION
bl kanban card ID
bl kanban card ID --history
```

Cards and tasks share `body` (brief), `acceptance` (criteria) and `summary` (current account). Updates replace these fields; omitted fields stay unchanged. Keep tickets self-contained and concise. Notes hold selective supporting evidence.

`board` and `next` return summaries without briefs or history. Pages default to 20, maximum 100; continue with `--offset` set to `nextOffset` until null. Pages are not a shared snapshot. `card` returns the current record, parent and child-task summaries; `--history` additionally returns all task-local notes and ownership claims.

`BL_ACTOR` in the invoking caller's environment defaults authorship and claim ownership; explicit flags win. Claim requires an owner, and feature claims require a branch. Claims retain immutable ownership history and reject refinement cards or unresolved dependencies. Finish refuses unfinished descendants unless `--outcome abandoned` explicitly cascades them as unactioned. Acceptance quality and verification remain the caller's responsibility; an agent exit or merge is not task completion.

Progression is opt-in: `kanban add TITLE --progression children` or `kanban update ID --progression children`. The card and its descendants may start freely, but cannot enter review/production or close while contained work remains unresolved. All `parent-of` work counts, including generic nodes. Adding/reopening unfinished work beneath an advanced parent requires moving the parent back first. `free` is the default; ordinary finish still protects unfinished descendants. Unfinished abandonment cannot bypass the opted-in policy.

`blocked` is the presentation of explicit unresolved blockage records, not a manually selected lane. `block` records an immutable reason, raiser, optional needed-from identity, timestamp, and one `blocks` link to owned active work. `unblock` closes that record with immutable resolution evidence; repeating the same resolution is idempotent and a conflicting resolution fails. Caller identity defaults from `BL_ACTOR`; explicit identity wins.

A blockage applies to its target and every `parent-of` descendant, across arbitrary group nodes and domains. It does not become a child or dependency, change assignment, or alter graph readiness. Effective unresolved blockages prevent Kanban claim and completion.

A card also projects to the blocked lane when unresolved blockage records target anything in its `parent-of` subtree. This wider projection is presentation only: a blocked sibling does not prevent unrelated claims or completion. The prior lane is restored from `kanban/blockage-previous-lane` only after all visible blockages clear. Card detail includes active and resolved visible blockage history; board, next, card, and child summaries identify each blockage's target and domain.

Workflows are a separate optional extension; Kanban neither loads XState nor interprets checkpoints. See the [spike walkthrough](../../docs/workflow-spike.md).

Linked cards mirror their authoritative workspace. Change the source and refresh its snapshot; reads show live state or explicitly mark the snapshot unavailable. Links use canonical workspace identity, survive renames, and reject duplicate sources, self-links and task targets.
