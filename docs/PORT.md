# Port progress

Source contract: `/Users/ct/dev/projects/skein-port-brief/PORT.md`. Fresh databases only. Implementation stays in this chat; Luna may perform read-only recon and validation.

## Plan

- [x] Storage: EAV attributes, graph invariants, queries, atomic batches, notes, archival, burn tombstones, stale writes and domain guards.
- [x] Runtime: explicit inert spool activation, typed Standard Schema ops, CLI/discovery, streams, events, clock and durable wakes.
- [x] Go Mill/strand: pooled Bun hosts, isolated workspace workers, independent restart, friendly routing, process custody and adoption.
- [x] Batteries, Identity and Harnesses: providers, aliases, native session registration, runs, assignment/review, retry/resume and reconciliation.
- [x] Kanban: ownership source records, boards/tasks, notes, lifecycle, references and peer links.
- [x] Cron: calendar/interval jobs, timezone/DST, durable occurrences, overlap/missed/retry policy and reconciliation.
- [x] Disposable blackbox verification, external spool lifecycle, pool isolation/recovery and measurements; prune temporary unit tests and docs.

## Decisions

- Bun owns each workspace database and registry inside its own Worker. Go Mill retains command custody outside Bun host lifetimes.
- Domain guards run synchronously inside the graph write transaction. Async validation happens before entering transactions.
- CLI syntax, JSON Schema export and Standard Schema validation are separate descriptors.
- No Workflow, JVM bootstrap, hot reload, migration or compatibility layers.

## Evidence

- Initial repository: clean Bun scaffold at `a76264c`; Bun 1.4.2, Go 1.26.8.
- Full quality/test commands must use `qlock exec --lock /tmp/agent-cpu.lock -w 30 -- …`.

## Status

Implementation and validation complete for the selected scope. Only blackbox contract tests remain; no temporary unit tests or databases are retained.

- Public API tests cover EAV/query/graph invariants, rollback, stale writes, guards, post-commit events, async Zod/Valibot input and output transformations, lifecycle cleanup, durable wake cancellation, Cron/DST/retry/recovery, and Kanban ownership and cascades.
- Real Go/Bun tests cover workspace isolation, relative paths and friendly names, independent dependencies/restarts, custody adoption, native hooks, assignment/review, retry/resume fencing, peer links, failed-startup cleanup, streaming/deadlines and failed-member host recovery.
- Strict TypeScript, Oxlint/Oxfmt, Go vet/build, Linux amd64 cross-build, JSON Schema export and the disposable pool benchmark pass. Full suites use `qlock exec --lock /tmp/agent-cpu.lock -w 30 -- …`.
- A concurrent test exposed timestamp request-ID collisions between separate Go clients. Requests now use cryptographic random IDs; the host rejects active duplicates. Consulted Astra on custody/identity/scheduler fencing and added regressions for the resulting fixes.
- Go process custody and native observers originate from the source checkout identified by the brief; unused JVM/process-liveness machinery was pruned. No native plugins were installed into user profiles.
- Strict TypeScript and unsafe-value lint checks remain enabled. Pedantic style rules conflicting with sequential lifecycle execution, mutable runtime APIs, Node worker messaging and cohesive domain modules are disabled explicitly.

## Port boundaries

- Retained: EAV/archive semantics, DAG/serves invariants, atomic batches and guards; Standard Schema v1 with explicit CLI and JSON Schema metadata; durable wakes and Cron occurrences; Go custody with worker/host adoption; Identity, Harnesses and Kanban without Workflow.
- New authoring/configuration: typed descriptors, explicit spool activation, JSON workspace/Harnesses/job schemas, UUID strand IDs and strict JSON inputs. This is not wire/CLI compatibility with existing JVM installations.
- Old API surfaces omitted: managed interactive TTY launch, Kanban terminal dashboard/HTML rendering, Clojure weave shorthand and origin-identity replication across workspaces. Library batches, graph export, explicit raw actor/owner evidence and headless providers cover the selected core scope.
- Explicit runtime limits: deadlines signal cancellation cooperatively; wake delivery and crash-recovered Cron actions are at least once. Consumers deduplicate external effects using occurrence IDs. Mill custody lasts for the daemon lifetime; automatic adoption covers Bun host/member failure, not a killed/replaced Mill daemon.
- Fresh databases only. Workflow/adapters, unselected Millhouse domains, JVM/nREPL, owner partitions, generic middleware, migration, hot reload and Rust/Wasm remain excluded.

## Measurements

2026-10-25, Apple M4/macOS arm64/Bun 1.4.2, 24 workspaces: 365.2 MiB total Bun host RSS (13.8 MiB incremental/workspace), 635 ms total member startup, 25.3 ms median member startup. While one worker performed two million SQLite updates, sibling latency was p95 2.89 ms / p99 23.61 ms; sibling timer delay p99 1.27 ms; member replacement 27.8 ms. This is one local run, including Mill routing, with the complete method and raw values in `docs/pool-benchmark.json` and a reproducible disposable script in `scripts/benchmark.ts`.
