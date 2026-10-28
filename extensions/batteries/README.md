# @botlake/extension-batteries

Everyday graph operations: add/show/list/ready/update, await, batches, queries, edges, notes, archival, supersede and burn. Requires the `@botlake/core` peer package; no prerequisite extensions.

Select `"@botlake/extension-batteries"` in workspace `extensions`, or default-export `batteries(namedQueries)` from a local module. The package's default export is an inert, unconfigured Batteries extension. The `q` predicate builders belong to core, not Batteries.

`bl list` and `bl ready` accept `--query NAME`, `--params JSON`, `--limit` and `--lean`. Inspect registered definitions with `bl query [NAME]`. For ad hoc predicates and JavaScript composition use [`botlake lake eval`](../../README.md#javascript-evaluation); `api.call("list"|"ready", { where, params, limit, lean })` retains programmatic selection. Raw `bl --input` also accepts predicates; there is no `--where` flag.

List/ready default to 100 results (maximum 10,000); a full result page does not establish completeness. Separate calls do not share a snapshot.

## Await

```sh
bl await --query node-closed --params '{"id":"NODE_ID"}' --min-count 1
bl await --query children-active --params '{"parent":"NODE_ID"}' --max-count 0
```

`await` checks a named query immediately, then every second until its count enters the inclusive min/max band. At least one bound is required; `--min-count 0` alone is rejected. Query and parameters are resolved once; unknown or missing parameters fail before waiting.

`--timeout-secs` defaults to 1800 (maximum 2147483); zero probes once. The single JSON result has `reason: "satisfied" | "timeout"`, `count`, `countLimit`, bounds and `elapsedMs`. Both reasons exit zero: check the reason before continuing. Counts stop at the minimum, or maximum-plus-one; `count === countLimit` means at least that many, not an exact total. `bl --timeout 5s await ...` imposes a separate hard deadline that exits nonzero. Disconnecting cancels the wait, not the work being observed.

Shipped queries: `node-closed` and `node-active` take `id`; `children-active` takes `parent`; `blockers-active` takes the dependent's `id`. Active-set disappearance can mean closure, replacement or deletion, not success. Other selected extensions may register domain queries, such as Agents' `agent-run-settled` with `runId`.
