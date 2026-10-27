# @botlake/spool-kanban

Boards, cards/tasks, immutable ownership history, notes, lifecycle operations and linked cards. Install the `@botlake/core` and `@botlake/spool-identity` peers; explicitly select both Identity and Kanban in workspace `spools`.

The default export is an inert Kanban spool; `kanban()` and `Kanban` are the programmatic API. Batteries, Harnesses and Cron are not dependencies. Guards protect domain records even through generic graph mutations. Peer-linked cards remain mirrors of their authoritative workspace. Links resolve names/paths to canonical workspace identity, survive name changes, and reject duplicate sources, self-links and task targets. Reads show live data or explicitly mark the stored snapshot unavailable; refresh persists it.
