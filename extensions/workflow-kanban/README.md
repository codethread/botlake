# @botlake/extension-workflow-kanban

Explicitly select Identity, Kanban and Workflow, then this adapter. Core remains extension-independent.

A Kanban card opts into `--progression children`. Link independent roots with `workflow start NAME --parent CARD_ID` or `workflow-kanban attach CARD_ID RUN_ID`. `workflow-kanban show CARD_ID` lists linked roots and the card policy. The card may be claimed while workflows run, but cannot review or finish until its contained work settles. Finishing workflows never automatically finishes the card.

This adapter only links and inspects containment. Kanban owns progression and blocked-column presentation. Both domains independently implement the [work blockage protocol](../../docs/work-blockages.md); the adapter owns no pause controls, bookmarks or synchronization process.
