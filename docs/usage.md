# Workspace configuration

Requires Bun and `botlake`/`bl` on `PATH`; see [Homebrew installation](../README.md#install-with-homebrew) or [checkout setup](engdocs/development.md#setup) for installation from source. Runtime commands describe themselves through `bl -h`, `bl help`, `bl prime OP` and `botlake -h`.

## Lake definition and workspace selection

Initialize a workspace with Batteries selected:

```sh
botlake init --workspace /absolute/workspace --name work
```

`init` pins Core to the standalone archive in Botlake's Git repository and Batteries to the matching npm version. It adds local ignore rules for `node_modules` and `world.db*` (including SQLite sidecars) and creates `.botlake/bunfig.toml` with isolated installs and a seven-day minimum release age, exempting only Core and Batteries. Existing package fields, ignore rules and local Bun configuration are preserved. An existing `.botlake/lake.ts` definition is left unchanged.

Root Bun files determine installation:

```text
init
  |
  v
root bun.lock? -- yes --> Skip installation; suggest adding .botlake to root
  |                      package.json workspaces or installing manually.
  |                      Missing root bunfig.toml? Recommend adding one.
  no
  |
  v
Report root bunfig.toml presence, then run
bun install --frozen-lockfile inside .botlake.
```

Guidance and install output go to stderr; stdout remains JSON. Root files are never modified. With a root workspace, extend its Bun install policy as needed. Install failures return nonzero; fix the error and rerun `bun install --frozen-lockfile` inside `.botlake`.

Configuration dependencies live in `.botlake/package.json`; the inert lake definition lives in `.botlake/lake.ts`:

```ts
import { createLake } from "@botlake/core";
import { batteries } from "@botlake/extension-batteries";

import { priming } from "./priming.ts";

export const lake = createLake({
  name: "work",
  extensions: [batteries(), priming],
});
```

`name` defaults to the workspace directory basename, not the package name. An explicit name starts with a letter and contains only letters, digits, underscores or hyphens; active lake names must be unique. `extensions` is required and may be empty. Importing or installing an extension does not activate it; only values in this array are selected.

`botlake status` reports `coreVersion` and `lakeWireVersion` per member, as do `botlake lake list`, lake lifecycle responses and `botlake lake status`. The top-level `protocolVersion` describes CLI–supervisor communication, not lake compatibility. `botlake lake info` reports `coreVersion` from the lake's installed `@botlake/core/package.json` and the core-defined `lakeWireVersion`. The supervisor checks wire compatibility before activating extensions; a mismatch fails startup with both versions. Declare core requirements in package dependencies and extension peer dependencies; the lake definition needs no version constraint.

The definition is trusted TypeScript and is imported only during explicit start or restart. Each lake therefore runs the runner and core pinned by its own `.botlake/bun.lock`; the Go supervisor does not parse TypeScript or share a Bun host between lakes.

CLI workspace selection is `--workspace PATH|NAME`, then nonempty `BL_WORKSPACE`, then Git discovery. Git discovery uses the main checkout's configuration and `.botlake/world.db`, shared by subdirectories and linked worktrees; worktree-local configurations are ignored. Outside Git, set `BL_WORKSPACE` or pass `--workspace`. Published names select active lakes; a new lake needs a path.

An explicit selection stays in effect across directory changes. `bl --cwd DIR` and `botlake lake eval --cwd DIR` set invocation context, but only select that directory's lake when neither `--workspace` nor `BL_WORKSPACE` is set. An unavailable selected workspace fails rather than falling back to the current directory's lake.

## Packages and extension selection

Public runtime packages are published to npm as Bun-native TypeScript without a build step. Install `@botlake/core` and chosen extensions into the workspace or its `.botlake` package. `latest` tracks the npm dist-tag when updating; lockfiles retain the resolved versions until updated. For local tarballs, run `bun pm pack` inside each source package; Bun rewrites workspace dependency ranges. For offline tarball installs, point both consumer `dependencies` and `overrides` at the tarballs for every `@botlake/*` peer.

For local package development, install a Bun-packed tarball. This keeps the package’s source TypeScript while resolving its rewritten dependencies from the consuming installation. A private package can be packed and installed locally without publishing it.

- Bun resolves package imports from `.botlake`; relative imports in `lake.ts` resolve from `.botlake`.
- Each selected value must satisfy the `Extension` contract.
- Installed package dependencies and selected extension prerequisites are separate: explicitly select every required extension, in any order.
- Installation and imports do not activate extensions. Activation registers operations; resources start after dependency and collision validation.

Extension-owned factories, options and prerequisites are described in each extension's README. Available source packages live under [extensions](../extensions/).

## Configured local modules

Call an existing factory from a local module when an extension needs options. For example, save this as `.botlake/priming.ts` for the definition above:

```ts
import { priming } from "@botlake/core";

export const configuredPriming = priming({
  events: "Document new event contracts before publishing them.",
});
```

This appends workspace guidance to the core `events` primer. See [priming](../packages/core/README.md#priming) for the configuration contract.

Import `configuredPriming` into `lake.ts` and select it instead of the same extension's unconfigured value; selecting both causes an extension-name collision. Keep modules under `.botlake` when their imports are installed there. Extension options belong to the factory call.

Configuring a factory is distinct from [authoring a new extension](../packages/core/README.md#extension-authoring).

## Applying configuration

With a supervisor running (`botlake start` in a separate terminal), start an inactive lake by path:

```sh
botlake lake start --workspace /absolute/workspace
```

Pass `--install` to run `bun install` from `.botlake` before starting an inactive lake. If the install fails, the lake stays stopped. Named links must already be registered from their source checkouts.

After editing `lake.ts`, configured modules or lake environment, use `botlake lake restart --workspace /absolute/workspace`. Calling `start` on an already-running lake does not reload it. `botlake lake info --workspace work` reports the loaded snapshot and extension README/source locations, not pending edits.

If the replacement fails to start, the lake stays stopped. Restore the definition and dependency installation, then run `botlake lake start --workspace /absolute/workspace`.

## Environment

- `BL_WORKSPACE` selects the default lake independently of cwd; `--workspace` overrides it. Use an absolute workspace directory when sharing the environment with native session adapters, which require a path. Managed agents receive their owning lake's absolute path automatically.
- `BL_HOME` selects the supervisor and retained-output directory (default `~/.botlake`), not the workspace database location.
- `ctx.env.lake` captures the environment supplied at lake start or restart. Use this for extension startup configuration.
- `ctx.env.bl` contains each invocation caller's environment and is empty during activation. It remains separate from the lake environment.
- `BL_ACTOR` supplies the default caller identity; see `bl -h` for invocation overrides.

## Zsh completion

Generate the script after installing or upgrading the CLI:

```sh
mkdir -p "${XDG_CACHE_HOME:-$HOME/.cache}/zsh"
botlake completions zsh > "${XDG_CACHE_HOME:-$HOME/.cache}/zsh/botlake.zsh"
```

Source it from `~/.zshrc` after `compinit`:

```zsh
source "${XDG_CACHE_HOME:-$HOME/.cache}/zsh/botlake.zsh"
```

Only zsh is supported. Base completion works offline; dynamic `bl` completion needs `jq` and a running lake.
