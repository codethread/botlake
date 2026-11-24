# Botlake runtime changelog

This history covers the npm runtime packages. The [Go CLI changelog](cli/CHANGELOG.md) is separate.

## 0.7.1 — Fable for Oracle

The `ct-config` preset enables Claude by default and uses Claude Code's `fable` model alias. The `oracle` seat selects Fable when available and Astra otherwise. This fallback happens before launch; it does not retry failed runs.

## 0.7.0 — Work and Agent read APIs

**Breaking for readers upgrading from 0.6.x:** four operations now return summaries instead of full records by default. An omitted field does **not** mean its stored value is empty. Mutations, `work list`, `agent activity list/search`, and Mail inbox behavior are unchanged. No database migration or Go CLI upgrade is required.

### `work show ID`

- Keep reading `item`, `ready` and assignment metadata. For owned work, `counts` reports `noteLines`, `criteria`, `ancestors`, `members`, `prerequisites` and `references`; `item.parent` identifies the immediate group.
- Request `--show-description` for `item.description`, `--show-notes` for **all** `item.notes`, and `--show-criteria` for `item.acceptanceCriteria`. `--show-context` returns ancestor summaries; combine it with `--show-description` for ancestor briefs. For a gate's parameters and retry policy, use `--show-gate-config`.
- Replace **`--history` with `--show-history`**, or `history: true` with `showHistory: true` in JSON input. This expands history only, not notes or current criteria.
- `prerequisites`, `references` and `members.items` share one offset and limit (default 20 per collection; maximum 100). Pass the **top-level `nextOffset`** back as `--offset` until null, even if `members.nextOffset` is null. A reference ID still returns its source-owned summary, not local task details.

### `agent show ID`

The response is a run summary, **not a graph node**. For example, replace `jq '.attributes["agent/state"]'` with `jq '.state'`. Top-level `state` is the agent lifecycle state, not the old graph state. Read `substatus`, `settled`, `seat`, `provider`, `identity`, `sessionId`, `location` (cwd) and `attempt` directly.

- Check `resultAvailable` / `errorAvailable`; request `--show-result` / `--show-error` and read `.result` / `.error`. A settled run need not have succeeded. For the accepted prompt, launch specification or frozen settings use `--show-prompt`, `--show-launch` or `--show-settings`; read `.prompt`, `.launch` or `.settings` respectively. Launch can include stdin and environment values.
- External sessions have no managed settlement verdict. Followed runs expose `reference` and `observedState`, not the owner's result or custody. Request any expansion at `reference.workspace` using `reference.nodeId`. For raw graph attributes on an owned run, use `bl node show ID --include-archived` with Batteries selected.

### `agent activity peek ID`

`recent` and `outstandingTools` now default to five rows each, with `kind`, `tool`, `summary`, `outcome` and `truncated`. Summaries are previews of up to 160 characters. `moreRecent` and `moreOutstandingTools` distinguish a limited window from all retained matches. `stream` defaults to `id`, `eventCount` and `expiredAt`; `observedAgoMs` and `latestUsage` remain available.

For the previous level of detail (including event IDs, timestamps and native stream metadata):

```sh
bl agent activity peek RUN_ID --show-events --show-stream --limit 20
```

Increasing `--limit` alone does not expand rows. To read beyond the snapshot, page `bl agent activity list HANDLE` using `--after NEXT_CURSOR` until `nextCursor` is null.

### `agent catalog NAME`

Routing, settings and candidates remain visible, but prompt text is no longer duplicated in `settings.systemPrompt` and `candidates`. Use `--show-system-prompt` **with a seat name** and read `candidates[selectedCandidate].systemPrompt` for the selected alias candidate. A missing prompt means none was explicitly configured there; a callback is represented by `{ "dynamic": true }`, never evaluated by inspection. To see the resolved settings of an actual managed run, use `bl agent show RUN_ID --show-settings`.

### Upgrade consumers

1. Update parsers and invocations together, including validators that previously required expanded fields. For `bl --input` / `runtime.invoke`, each `--show-*` flag maps to a camelCase boolean, e.g. `showNotes`, `showEvents`, `showSystemPrompt`. Inspect the target lake with `bl help work show` or `bl help agent activity peek` when supporting mixed versions.
2. **Botlake UI:** a UI using `history: true`, raw Agent attributes, or full peek rows needs a matching migration for the work inspector, run replies and activity view. Keep those lakes pinned to 0.6.x until the UI is updated; updating the runtime does not update the UI server.
3. Update the lake's selected public Botlake runtime packages together to `0.7.0`, install and commit the lockfile, then restart **that lake** to load them. Confirm its loaded `coreVersion` with `botlake lake info --workspace PATH`. The Go supervisor does not need a restart.
