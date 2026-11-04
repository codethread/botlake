# Development

## Setup

Requires Bun, Go, mise and a sibling `botlake-ui` checkout, as referenced by the [dogfood manifest](../../.botlake/package.json). From the Botlake checkout:

```sh
mise run install
export PATH="$HOME/.local/bin:$PATH"
```

The [mise tasks](../../mise.toml) install workspace dependencies and both Go CLIs into `~/.local/bin`. The installed binaries use this checkout's core by default; keep its source and dependencies in place.

If no supervisor is running, start one in a separate terminal:

```sh
botlake start
```

Then start the development lake:

```sh
botlake lake start
```

The `setup` mise task also requests `botlake bin build ui`; the UI server itself starts separately from the UI checkout. Inspect `botlake bin list` and `botlake bin help build` before using that task with a different UI extension build contract.

## Development lake

The private `.botlake` package uses workspace dependencies and explicitly selected extensions. Source configuration lives in its [manifest](../../.botlake/package.json), [agent seats](../../.botlake/agents.ts) and [flag defaults](../../.botlake/flags.ts). Use `bl agent catalog` for effective seat selection rather than relying on a duplicated list of model aliases.

Git discovery shares the main checkout's configuration and ignored `.botlake/world.db` across subdirectories and linked worktrees. Installing dependencies does not build UI or launch agents; Cron has no jobs until configured. Work Agents remains an explicit optional configuration.

Install the [native identity adapter](../../plugins/identity/README.md) explicitly before launching native sessions. Managed runs are headless. For configured seats and delegation, use the [Agents guide](../../extensions/agents/README.md#catalog-and-routing); flags and database overrides are described by [Flags](../../extensions/flags/README.md).

## Rebuild and reload

- Go changes: rebuild with `mise run install` and restart the supervisor through its process manager, or stop/start it manually. Supervisor replacement ends process custody and clears published lake routes; start the required lakes again.
- Workspace TypeScript/configuration changes: `botlake lake restart`.
- Host changes: `botlake restart-host` restores active lakes without replacing the supervisor.

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
```

Blackbox tests pack and install packages outside the checkout, then exercise real Go/Bun processes and disposable databases. Schema export also accepts `job`, `agents` or `flags`; each schema is owned by its package. See [Workflow verification](../../extensions/workflow/README.md#persistence), [runtime limits and native smoke verification](LIMITS.md) and [pool measurements](pool-benchmark.json).
