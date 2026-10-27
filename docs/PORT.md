# Port scope

Fresh databases only. Core and domain spools are separate Bun workspace packages; see the [package map](../README.md#packages).

- Retained: EAV/archive semantics, DAG/serves invariants, atomic batches and guards; Standard Schema v1 with explicit CLI and JSON Schema metadata; durable wakes and Cron occurrences; Go custody with worker/host adoption; Identity, Harnesses and Kanban without Workflow.
- Authoring: typed inert descriptors, explicit activation, package-owned configuration schemas, UUID strand IDs and strict JSON inputs. `q` builds serializable predicates; `mill weaver eval` runs trusted caller-side JavaScript over normal operation RPC, not an in-worker REPL. No wire/CLI compatibility with JVM installations.
- Omitted: managed interactive process TTY launch, Kanban terminal dashboard/HTML rendering, Clojure weave shorthand and origin-identity replication across workspaces. Local executable bins do retain terminal I/O. Library batches, graph export, raw actor/owner evidence and headless providers cover the selected domain scope.
- Mill differences: `init` creates empty JSON configuration only. Durable auto-start registration, stealth Git setup, temporary Weaver databases, lifecycle name overrides/readiness-budget flags, changelog delivery and shell completion are omitted. Names come from workspace JSON or its basename; status/lifecycle results are JSON and startup/shutdown waits are bounded internally. These release/bootstrap conveniences are outside the selected runtime deliverable.
- Runtime limits: deadlines signal cancellation cooperatively; wake delivery and crash-recovered Cron actions are at least once. Consumers deduplicate external effects using occurrence IDs. Mill custody lasts for the daemon lifetime; automatic adoption covers Bun host/member failure, not a killed/replaced Mill daemon.
- Excluded: Workflow/adapters, unselected Millhouse domains, JVM/nREPL, owner partitions, generic middleware, migration, hot reload and Rust/Wasm.

## Harnesses parity

The headless execution path and declarative catalog are implemented, not the full canonical Millhouse API:

- `provider(name)` supplies `prepare(ProviderRun)` / `finish(...)` adapters for Codex, Pi, Claude and Cursor. `harnesses({ providers, aliases, reviewers })` selects them at activation. Aliases support docs, parent inheritance, accumulated system prompts, flag expressions and ordered fallback candidates. Catalog inspection includes disabled seats and reasons.
- Runtime booleans belong to the independent Flags spool, not Harnesses. Consumers explicitly select it and configure defaults separately. `strand flag list|get|set|unset` changes workspace-local values until restart. Provider flags default enabled; unset custom condition flags are false. Accepted settings remain frozen across flags, retry and resume.
- Still missing: caller-sensitive allow/deny visibility, live alias registration/unregistration, arbitrary provider overlay attributes and per-run model/effort/extra-argv/system-prompt overrides. The local catalog does not enforce canonical allow/deny policy.
- CLI differs: `agent catalog [NAME]` inspects seats, `agent list` lists runs, and `agent start --seat ... --target ...` handles launch/assignment. No canonical `agent run`, `assign`, `config`, `reviewers` or managed interactive `agent` bin. Review uses a simpler Git diff/lens selection surface; Workflow remains excluded.
- Provider parity is partial: Codex passes effort through rather than mapping canonical `low` to `light`, and canonical default approval-bypass argv are not installed. This port reserves managed identities before launch, whereas current canonical Codex/Pi attach identities at native startup. Use this port's plugins, not canonical Millhouse plugins.
- The private workspace uses the reference model/effort settings, DeepSeek→Luna `grunt` routing and disabled-by-default Claude/Cursor. Its `reviewer` uses Sol→Opus rather than the reference's Terra-only selection. Additional model-family flags allow family-wide routing changes. `tui` remains headless; `reviewer` does not create a review lens.

Provider verification uses deterministic subprocess fixtures, not live model accounts. Matching model names and argv does not establish installed CLI/model availability.

## Verification

Blackbox contracts exercise graph/query invariants (including missing-value negation), rollback, immutable archival, guards, async Zod/Valibot validation, lifecycle cleanup, durable wakes, Cron policies/DST/recovery, and Kanban ownership. Process tests install packed packages in disposable workspaces and cover named routing, dependency isolation, planned/unexpected host recovery and custody adoption, native hooks, Harnesses, peer links and wire behavior. The completion checkpoint is tracked in [port progress](PORT-PROGRESS.md).

## Measurements

The [recorded pool benchmark](pool-benchmark.json) uses packed packages: 2026-10-26, Apple M4/macOS arm64/Bun 1.4.2, 24 workspaces, 479.2 MiB total Bun host RSS (18.5 MiB incremental per workspace), 995 ms total member startup. Under database load, sibling latency is p95 4.04 ms / p99 6.25 ms; sibling event-loop delay p99 1.33 ms; member replacement 43.5 ms. This is one local run, not a performance guarantee. Reproduce with `bun scripts/benchmark.ts 24` using disposable workspaces and real SQLite load.
