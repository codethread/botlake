# @botlake/extension-diary

Identity-owned, immutable diary entries. Install the Core and Identity peers. Imports are inert: explicitly select both `"@botlake/extension-identity"` and `"@botlake/extension-diary"` in workspace `extensions`, or select `identity()` and `diary()` programmatically. Kanban is not a dependency.

```sh
bl diary add "Investigated the flaky boundary" --identity IDENTITY
bl diary list IDENTITY --limit 20
bl diary list IDENTITY --after ENTRY_ID
bl diary show ENTRY_ID
```

`add` and `list` use the explicit identity, or the caller's `BL_ACTOR` when omitted. The identity must already be registered. `list` returns oldest-first previews, 20 per page by default (maximum 100); pass `next` as `--after` until null. Pages are not a shared snapshot. `show` returns the full entry; `add` returns only its ID, identity and time.

A diary is optional working history across tasks, not an automatic transcript. Promote useful conclusions into the task's current summary. Ownership history provides the path from a card to an identity's diary; diary entries are not automatically evidence for that card.
