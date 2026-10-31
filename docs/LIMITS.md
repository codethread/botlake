# Runtime limits

- Only the current database generation is supported; no data migrations or compatibility layer. Each lake stores nodes in `.botlake/world.db`.
- `botlake init` creates empty JSON configuration without installing or selecting extensions. Names come from configuration or the workspace basename. Durable auto-start registration and automatic temporary-database management are not implemented.
- Operation deadlines signal cancellation cooperatively. Evaluation runs in a separate caller-side process with an enforced overall deadline; it is trusted code, not a sandbox. Completed mutations are not rolled back if a script fails.
- Wakes and crash-recovered Cron actions are at least once. Deduplicate external effects using occurrence IDs.
- Process custody lasts for the supervisor lifetime. Host/worker recovery adopts retained processes; supervisor replacement does not.
- Managed agent launches are headless. Declared executable bins retain caller terminal I/O. Interactive agent launch, a work dashboard and cross-lake identity replication are not implemented. Work and authored Workflow are optional extensions; automatic dispatch and notification delivery are not supplied.

## Agents

Catalog aliases support documented seats, inheritance, flag expressions and ordered fallbacks. Accepted runs freeze their resolved settings. Caller-sensitive allow/deny visibility, live alias registration, arbitrary overlays and per-run model/effort/argv/prompt overrides are not implemented.

`agent catalog` inspects seats; `agent list` returns paged run summaries, and `agent show ID` expands full records. All managed seats, including `tui`, remain headless. Provider defaults do not bypass approval prompts. Install native identity adapters explicitly; native identity is distinct from process custody and task completion.

Provider tests use deterministic subprocess fixtures, not live model accounts. Configured model names do not establish installed CLI/model availability. Optional native events remain unknown when unavailable; GUI coverage requires a host that actually runs the adapters.

`bun scripts/native-smoke.ts both /tmp/native-smoke.json` probes authenticated Pi and Codex against Luna: managed start/resume, direct native registration, identity context and lifecycle metadata. Use `pi` or `codex` to select one; `BL_SMOKE_PI_MODEL` and `BL_SMOKE_CODEX_MODEL` override models. It copies existing native credentials into disposable homes, uses packed plugins and a disposable database, and removes them on exit. It never installs plugins globally or restarts the live runtime.

## Measurements

[Pool measurements](pool-benchmark.json) record one local run, not a performance guarantee. Reproduce with `bun scripts/benchmark.ts 24` using packed packages, disposable lakes and real SQLite load. RSS includes the Bun host and all workers, not the Go supervisor or load clients.
