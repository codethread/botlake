# @botlake/extension-kanban

Boards, cards/tasks, ownership and linked cards. Install the Core and Identity peers and explicitly select both Identity and Kanban. Imports are inert; `kanban()` and `Kanban` are the programmatic interface. Batteries, Agents and Diary are not dependencies.

```sh
bl prime kanban
bl kanban add "Investigate issue" --lane refinement --body "Problem, outcome and scope"
bl kanban update ID --acceptance "Observable success criteria" --lane pending
bl kanban claim ID --branch topic
bl kanban update ID --summary "Decision, verification and next action" --expected-revision REVISION
bl kanban card ID
bl kanban card ID --history
```

Cards and tasks share `body` (brief), `acceptance` (criteria) and `summary` (current account). Updates replace these fields; omitted fields stay unchanged. Keep tickets self-contained and concise. Notes hold selective supporting evidence; optional [Diary](../diary/README.md) holds identity-owned working history, reached through ownership rather than task links. Kanban never loads diary entries.

`board` and `next` return summaries without briefs or history. Pages default to 20, maximum 100; continue with `--offset` set to `nextOffset` until null. Pages are not a shared snapshot. `card` returns the current record, parent and child-task summaries; `--history` additionally returns all task-local notes and ownership claims.

`BL_ACTOR` in the invoking caller's environment defaults authorship and claim ownership; explicit flags win. Claim requires an owner, and feature claims require a branch. Claims retain immutable ownership history and reject refinement cards or unresolved dependencies. Finish refuses unfinished descendants unless `--outcome abandoned` explicitly cascades them as unactioned. Acceptance quality and verification remain the caller's responsibility; an agent exit or merge is not task completion.

Linked cards mirror their authoritative workspace. Change the source and refresh its snapshot; reads show live state or explicitly mark the snapshot unavailable. Links use canonical workspace identity, survive renames, and reject duplicate sources, self-links and task targets.
