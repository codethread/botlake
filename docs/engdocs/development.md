# Development

## Setup

Requires Bun, Go and mise. The [dogfood manifest](../../.botlake/package.json) installs `@botlake/extension-ui` from npm, as TypeScript source, including its executable Bun CLI; no UI checkout or build is needed. From the Botlake checkout, run:

```sh
mise run install
export PATH="$HOME/.local/bin:$PATH"
```

The [mise tasks](../../mise.toml) install development dependencies, install the shared configuration package and the independent lake and place both Go CLIs in `~/.local/bin`.

If no supervisor is running, start one in a separate terminal:

```sh
botlake start
```

Then start the development lake:

```sh
botlake lake start
```

The `setup` mise task installs Botlake and starts this checkout's lake. The UI server itself starts separately from the UI checkout.

## Development lake

The private `.botlake` package is an independent consumer. Its lockfile pins the cutover Core and UI archives in `vendor/botlake-cutover` and resolves the remaining public dependencies from npm. Source configuration lives in its [lake definition](../../.botlake/lake.ts), [package manifest](../../.botlake/package.json), [shared configuration](../../extensions/ct-config/README.md) and [lake wrappers](../../.botlake/src/). Use `bl agent catalog` for effective seat selection rather than relying on a duplicated list of model aliases.

Git discovery shares the main checkout's configuration and ignored `.botlake/world.db` across subdirectories and linked worktrees. Installing dependencies does not build UI or launch agents; Cron has no jobs until configured. Work Agents remains an explicit optional configuration.

Install the repository-local [native identity adapter](../../plugins/identity/README.md) through the supported harness tooling before launching native sessions. It is private harness integration, not an npm runtime package. Managed runs are headless. For configured seats and delegation, use the [Agents guide](../../extensions/agents/README.md#catalog-and-routing); flags and database overrides are described by [Flags](../../extensions/flags/README.md).

## Rebuild and reload

- Go changes: rebuild with `mise run install` and restart the supervisor through its process manager, or stop/start it manually. Supervisor replacement ends process custody and clears published lake routes; start the required lakes again.
- Lake-local configuration changes: `botlake lake restart`.
- Shared configuration changes: release `@botlake/extension-ct-config`, update consumer lockfiles and restart affected lakes.
- Public runtime changes: release and update the installed package before restarting; source edits do not change the running npm package.

Core stays extension-independent. Cross-package imports use declared dependencies and public exports, never relative source paths; Oxlint enforces the seam. Package prerequisites must be selected explicitly. See [contribution rules](../../AGENTS.md).

## Verify

```sh
bun run check
bun run check:go
bun test tests/blackbox
bun scripts/schema.ts workspace
bun scripts/benchmark.ts 24
bun scripts/cli-smoke.ts # Fresh lake + read-only snapshot clone of this checkout
bun scripts/work-smoke.ts
bun scripts/workflow-smoke.ts
bun scripts/work-agent-smoke.ts
bun scripts/runtime-extension-smoke.ts # Typed composition, lifecycle and restart over disposable SQLite
```

Blackbox tests pack and install packages outside the checkout, then exercise real Go/Bun processes and disposable databases. Schema export also accepts `job`, `agents` or `flags`; each schema is owned by its package. See [Workflow verification](../../extensions/workflow/README.md#persistence), [runtime limits and native smoke verification](LIMITS.md) and [pool measurements](pool-benchmark.json).
