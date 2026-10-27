# @millstrand/spool-batteries

Everyday graph operations: add/show/list/ready/update, batches, queries, edges, notes, archival, supersede and burn. Requires the `@millstrand/core` peer package; no prerequisite spools.

Select `"@millstrand/spool-batteries"` in workspace `spools`, or default-export `batteries(namedQueries)` from a local module. The package's default export is an inert, unconfigured Batteries spool. The `q` predicate builders belong to core, not Batteries.

`strand list` and `strand ready` accept `--query NAME`, `--params JSON`, `--limit` and `--lean`. Inspect registered definitions with `strand query [NAME]`. For ad hoc predicates and JavaScript composition use [`mill weaver eval`](../../README.md#javascript-evaluation); `api.call("list"|"ready", { where, params, limit, lean })` retains programmatic selection. Raw `strand --input` also accepts predicates; there is no `--where` flag.

List/ready default to 100 results (maximum 10,000); a full result page does not establish completeness. Separate calls do not share a snapshot.
