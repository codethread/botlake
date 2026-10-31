# Workflow verification

Workflow is explicitly selected with Identity and Work. Authored XState definitions live in `.workflows/NAME/`; runs project their flow into Work groups and tasks, with no Kanban dependency. See the [Workflow contract](../extensions/workflow/README.md).

```sh
bun install
bun scripts/workflow-smoke.ts
```

The smoke packs the packages, builds both Go CLIs, and exercises authored definitions in disposable SQLite lakes.
