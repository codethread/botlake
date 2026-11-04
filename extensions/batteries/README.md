# @botlake/extension-batteries

Everyday graph operations: `node`, `edge`, `query`, `await` and `batch`. Node creation, reads, selection, updates, notes, archival, supersession, deletion and subgraphs live under `bl node`. Requires the `@botlake/core` peer package; no prerequisite extensions.

Select `"@botlake/extension-batteries"` in workspace `extensions`, or default-export `batteries(namedQueries)` from a local module. The package's default export is an inert, unconfigured Batteries extension. The `q` predicate builders belong to core, not Batteries.

`bl node list` and `ready` return `{ nodes, total, nextOffset }` pages of `{ id, title, state }` summaries. Continue with `--offset nextOffset` until `null`; page size defaults to 100 (maximum 10,000). `ready` selects active nodes with no active prerequisites; `list` includes every state unless filtered. Separate calls are not a snapshot.

Use `bl node show ID` for one full node, or `--lean=false` to expand page records. Reads omit archived attributes unless `--include-archived` is set. `show` and the explicit `subgraph` expansion also accept `--lean` to omit attributes. Archived values never participate in selection, even when returned.

Use `--query NAME --params JSON` for registered queries. `bl query` lists names, descriptions and parameter names; `bl query NAME` expands the predicate. For ad hoc predicates and composition use [`botlake lake eval`](../../packages/core/README.md#javascript-evaluation) or `bl --input`; both accept `where`, `params`, `limit` and `offset`. There is no `--where` shell flag.

`bl edge list [ID]` pages incident edges, or all edges when ID is omitted. It returns `{ edges, total, nextOffset }` with attributes omitted; `--lean=false` expands them. Use leaf help for defaults and filters. Graph mutations return their stored records; `batch` returns refs and committed changes atomically.

`bl node update ID --attributes JSON` applies a merge patch: objects merge recursively, arrays/scalars replace, and null deletes keys. `bl node set-attributes ID --attributes JSON` replaces supplied values verbatim, preserving nested and top-level nulls; omitted keys stay unchanged. Both accept `--expected-revision`.

## Await

```sh
bl await --query node-closed --params '{"id":"NODE_ID"}' --min-count 1
bl await --query children-active --params '{"parent":"NODE_ID"}' --max-count 0
```

`await` checks a named query immediately, then every second until its count enters the inclusive min/max band. At least one bound is required; `--min-count 0` alone is rejected. Query and parameters are resolved once; unknown or missing parameters fail before waiting.

`--timeout-secs` defaults to 1800 (maximum 2147483); zero probes once. The single JSON result has `reason: "satisfied" | "timeout"`, `count`, `countLimit`, bounds and `elapsedMs`. Both reasons exit zero: check the reason before continuing. Counts stop at the minimum, or maximum-plus-one; `count === countLimit` means at least that many, not an exact total. `bl --timeout 5s await ...` imposes a separate hard deadline that exits nonzero. Disconnecting cancels the wait, not the work being observed.

Shipped queries: `node-closed` and `node-active` take `id`; `children-active` takes `parent`; `blockers-active` takes the dependent's `id`. Active-set disappearance can mean closure, replacement or deletion, not success. Other selected extensions may register domain queries, such as Agents' `agent-run-settled` with `runId`.
