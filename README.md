# Botlake

A programmable lake of connected nodes. `botlake` manages lakes and processes; `bl` invokes structured operations supplied by explicitly selected extensions.

- [User docs](docs/index.md) — workspace configuration and extension authoring.
- [CLI changelog](cli/CHANGELOG.md) — release history for `botlake` and `bl`.
- [Engineering docs](docs/engdocs/index.md) — checkout setup, development and verification.

Maintainer documentation lives under `docs/engdocs/`; the rest of `docs/` is user-facing. Extension-specific guides live in each extension's README.

## Install with Homebrew

```sh
brew tap codethread/botlake https://github.com/codethread/botlake
brew install codethread/botlake/botlake
```

The formula builds and installs both `botlake` and `bl`. Go is needed only for the build; Bun remains a runtime dependency. Core and extensions stay in each lake's dependency installation, not in Homebrew.

Start the supervisor, then initialize and start a lake:

```sh
brew services start codethread/botlake/botlake
botlake init --workspace /absolute/path/to/project
botlake lake start --workspace /absolute/path/to/project
bl --workspace /absolute/path/to/project help
```

Alternatively, run `botlake start` in a separate terminal instead of using Homebrew services. Installing the formula does not start services or activate extensions. See [workspace configuration](docs/usage.md) for dependency-install guidance when the project already has a Bun lockfile.

Upgrade with `brew upgrade codethread/botlake/botlake`. A running supervisor keeps its old executable until restarted; restart it explicitly, then start its lakes again. For a Homebrew-managed supervisor, use `brew services restart codethread/botlake/botlake`. Restarting ends its managed processes, so finish active work first.

## Development setup

Install mise, trust this repository's `mise.toml` if prompted, and run `mise run` (or `mise run bootstrap`) from the checkout root. It prepares pinned Bun and Go toolchains, workspace dependencies, agent skills and local CLI binaries without starting services or installing global commands. With a supervisor already running, `mise run setup` also starts the development lake. The explicit `mise run install` installs the CLIs into `GOBIN` or `~/.local/bin`; dots uses that task during authorized host bootstrap.

## License

Botlake is available under the [MIT License](LICENSE), Copyright (c) 2026 Botlake contributors. The core package preserves third-party attribution in its [NOTICE](packages/core/NOTICE).
