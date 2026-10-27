# @botlake/extension-kanban

Boards, cards/tasks, immutable ownership history, notes, lifecycle operations and linked cards. Install the `@botlake/core` and `@botlake/extension-identity` peers; explicitly select both Identity and Kanban in workspace `extensions`.

`BL_ACTOR` in the invoking caller's environment defaults `--by-identity` for add, note and claim, and `--owner` for claim. Explicit flags override defaults; add's reporter still defaults to its author. Without either `--owner` or `BL_ACTOR`, claim fails. The lake environment is never an attribution fallback.

The default export is an inert Kanban extension; `kanban()` and `Kanban` are the programmatic API. Batteries, Agents and Cron are not dependencies. Guards protect domain records even through generic graph mutations. Peer-linked cards remain mirrors of their authoritative workspace. Links resolve names/paths to canonical workspace identity, survive name changes, and reject duplicate sources, self-links and task targets. Reads show live data or explicitly mark the stored snapshot unavailable; refresh persists it.
