# Development

## Setup

Requires mise. Trust the repository's `mise.toml` if prompted, then run `mise run` (or `mise run bootstrap`) from the checkout root. This prepares pinned Bun and Go toolchains, agent skills, the root Bun workspace and both Go CLIs in `out/`, without starting services or installing global commands. The explicit `mise run install` additionally installs the CLIs into `GOBIN` or `~/.local/bin`, preserving the dots host-bootstrap handoff. Use a temporary `GOBIN` to verify installation without replacing the host's commands.

The root workspace and `bun.lock` include the private [dogfood manifest](../../.botlake/package.json). That manifest continues to own its dependencies on published packages: it pins the versions compatible with its published Core 0.2.1, independently of local workspace versions. The UI remains the vendored npm tarball in `vendor/botlake-cutover`, not a source-workspace link. No package is separately installed.

`skillbox sync` restores the bundles selected in `skillbox/config.json`, verifying contents against `skillbox/lock.json`; commit both files together. Botlake-owned sources live in `skillbox/botlake/`. Edit those sources, not the ignored `.agents/skills/` installation or its `.claude/skills` link. Sync rejects source hash drift rather than updating the lock.

If no supervisor is running, start it in a separate terminal with the host's existing `botlake start` command. Then `mise run setup` starts this checkout's lake using the local binary in `out/`. The UI server itself starts separately from the UI checkout.

## Development lake

The private `.botlake` workspace is an independent consumer. Its direct published Core and extension dependencies remain in its [package manifest](../../.botlake/package.json); the root lockfile records them separately from local source workspaces. The UI archive remains in `vendor/botlake-cutover`. Source configuration lives in its [lake definition](../../.botlake/lake.ts), [shared configuration](../../extensions/ct-config/README.md) and [lake wrappers](../../.botlake/src/). Use `bl agent catalog` for effective seat selection rather than relying on a duplicated list of model aliases.

Git discovery shares the main checkout's configuration and ignored `.botlake/world.db` across subdirectories and linked worktrees. Installing dependencies does not build UI or launch agents; Cron has no jobs until configured. Work Agents remains an explicit optional configuration.

Install the repository-local [native identity adapter](../../plugins/identity/README.md) through the supported harness tooling before launching native sessions. It is private harness integration, not an npm runtime package. Managed runs are headless. For configured seats and delegation, use the [Agents guide](../../extensions/agents/README.md#catalog-and-routing); flags and database overrides are described by [Flags](../../extensions/flags/README.md).

## CLI changelog

`botlake` and `bl` share one Go CLI version, so their release history belongs to `cli/`, separate from the independently versioned published Bun packages. Curate verified release facts in [`cli/changelog.json`](../../cli/changelog.json); it starts empty rather than claiming undocumented history. Generate `cli/CHANGELOG.md` with `bun run changelog:generate`, validate generated-file sync with `bun run changelog:check`, and query recorded releases with `bun run changelog -- --since VERSION` or `--release VERSION`. Queries use `out/botlake --version`; `--version VERSION` selects another installed-version cutoff. `bun run check` includes the sync validation.

## Rebuild and reload

- Go changes: rebuild local binaries with `mise run bootstrap`; explicitly install them with `mise run install` when deploying. Restart the supervisor through its process manager, or stop/start it manually, only with authorization. Supervisor replacement ends process custody and clears published lake routes; start the required lakes again.
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
