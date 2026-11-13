# Botlake

A programmable lake of connected nodes. `botlake` manages lakes and processes; `bl` invokes structured operations supplied by explicitly selected extensions.

- [User docs](docs/index.md) — workspace configuration and extension authoring.
- [CLI changelog](cli/CHANGELOG.md) — release history for `botlake` and `bl`.
- [Engineering docs](docs/engdocs/index.md) — checkout setup, development and verification.

Maintainer documentation lives under `docs/engdocs/`; the rest of `docs/` is user-facing. Extension-specific guides live in each extension's README.

## Development setup

Install mise, trust this repository's `mise.toml` if prompted, and run `mise run` (or `mise run bootstrap`) from the checkout root. It prepares pinned Bun and Go toolchains, workspace dependencies, agent skills and local CLI binaries without starting services or installing global commands. With a supervisor already running, `mise run setup` also starts the development lake. The explicit `mise run install` installs the CLIs into `GOBIN` or `~/.local/bin`; dots uses that task during authorized host bootstrap.

## License

Botlake is available under the [MIT License](LICENSE), Copyright (c) 2026 Botlake contributors. The core package preserves third-party attribution in its [NOTICE](packages/core/NOTICE).
