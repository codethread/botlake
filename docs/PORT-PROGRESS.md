# Port progress

Source of truth: `/Users/ct/dev/projects/skein-port-brief/PORT.md`, plus the user's addition of Strand flags and TTY-aware help. Fresh databases; no JVM compatibility layer. The existing package split is preserved.

## Implemented

- Independent core, Batteries, Identity, Flags, Harnesses, Kanban and Cron packages: inert imports, explicit selection/prerequisites, package-owned configuration/assets and public dependency boundaries.
- Private `.millstrand` Bun workspace for repo dogfooding: `workspace:*` dependencies linked by the root install, all shipped spools selected, no public exports, SQLite state ignored by Git. Package resolution starts in the configuration directory.
- Bun host with a worker and SQLite connection per workspace. Go Mill owns commands across worker/host replacement. Foreground `mill start`, `mill init`, version reporting, `mill weaver start|restart|stop|status|list` and named/path routing.
- Executable bins restored as `mill bin list|build|run`: declared paths or PATH commands, explicit build recipes, environment overlays, literal arguments, caller cwd and terminal I/O, signals and exit status. They are not operation aliases.
- EAV graph, archive/immutable attributes, relations/readiness, named/ad hoc queries and atomic batches. Core `q` builders replace handwritten predicate trees in spools. Corrected missing/null negation, supersession collisions, aliased batch IDs and duplicate burn events.
- `mill weaver eval` runs trusted JavaScript in a caller-side Bun process with `q` and `api.call`, inline/file/stdin sources, named/path workspace selection, JSON-only results and an overall enforced deadline. Strand list/ready expose named queries, not a `--where` flag; predicate input remains available programmatically.
- Nested savepoints and post-commit event/timer effects; rollback cannot leak notifications or cancel committed wakes.
- Async Standard Schema validation, recursive CLI metadata, JSON Schema input exports, discovery, validated streams, deadlines and strict wire envelopes. Large Unicode peer responses handle backpressure and split UTF-8 correctly; single-result peer calls reject streams without replay.
- Strand globals before the operation: workspace/context, timeout, `--stdin`, repeatable `--payload NAME=PATH`, `--input JSON|@FILE|-`, dry-run, version, help and JSON output. Missing/unused payload references fail; operation-owned flags remain opaque to the dispatcher.
- TTY-aware help: nested usage, arguments, required/repeatable flags, examples/runbooks, width/color detection, `NO_COLOR`, structured errors and JSON/NDJSON for pipes or `--json`.
- Startup/shutdown cleanup and failure reporting. Unexpected worker exit replaces that worker without replay; host recovery adopts retained processes without duplicate launches. Owner/key fencing, cancellation evidence and output acknowledgement are exercised through real processes.
- Harnesses headless providers/documented seat aliases, assignment/review, resume/retry and reconciliation. Codex, Pi, Claude and Cursor preserve native session evidence and completed results on failed/interrupted output. Cursor owns its bundled prompt/native-session hook. Native sessions have no process-cancellation authority; successful processes do not close Kanban tasks. Catalog inheritance, flag expressions and ordered fallbacks are supported; caller-sensitive allow/deny visibility is not. See [Harnesses parity](PORT.md#harnesses-parity).
- Independent Flags spool supplies workspace-local runtime booleans, defaults and `flag list|get|set|unset`, reusable by any spool. Harnesses reads flags through its public dependency; core remains spool-independent.
- Private workspace catalog includes the reference model/effort seats, documented roles, DeepSeek→Luna `grunt`, Sol→Opus `reviewer`, and model-family gates. Claude/Cursor are registered but disabled by default. Activation launches nothing.
- Kanban boards/cards/tasks, ownership history, lifecycle guards and coordinator links. Names, paths and symlinks resolve to canonical source identity; links survive renames, reject duplicates/self-links/task targets and retain snapshots when peers are unavailable.
- Durable wakes and Cron occurrences: unchanged cadence, cancellation generations, missed/overlap/retry policies, stable IDs, restart recovery and calendar/DST behavior.

## Verification

- Retained blackbox suite: **31 passed, 0 failed, 424 assertions across 12 files**.
- Builder/eval smoke verified comparisons, parameters and edges; installed-package inline/file/stdin evaluation, joins, named queries, caller context, JSON-only output, errors, busy-loop deadlines and interruption against disposable SQLite. Temporary tests were removed afterward.
- Flags/catalog smoke verified independent consumers, workspace isolation, restart defaults, documented availability, live alias fallbacks and frozen accepted settings against packed packages and disposable SQLite. Focused checks also covered recursive conditions, inheritance, cycles and schema export; temporary tests were removed afterward.
- Focused tests for bins/init/Strand pass, including raw stdin and a real 64-column terminal. Provider subprocess tests cover all four adapters, new/resumed sessions and Cursor’s bundled hook.
- TypeScript, Oxlint, Oxfmt and Go vet pass. The final 24-workspace benchmark records 479.2 MiB host RSS (18.5 MiB incremental per workspace), 995 ms total startup, 6.25 ms sibling p99 latency, 1.33 ms event-loop p99 delay and 43.5 ms member replacement under DB load; see [measurements](pool-benchmark.json).
- Tests use disposable SQLite databases, packed external packages and real Go/Bun processes. Provider CLIs are deterministic fixture executables; live model services have not been invoked.

Retained blackbox contracts use the repository’s verification commands; temporary test scaffolding is removed after validation.

## Completion

The selected brief and the additional Strand input/TTY requirements are implemented and verified. No remaining build items are scoped for this deliverable. API omissions and runtime limits are explicit in [PORT.md](PORT.md); complete parity with the JVM product is not claimed. Publication, live provider-account testing and the omitted product surfaces are separate work.
