# Workspace configuration

Requires Bun and `botlake`/`bl` on `PATH`; see [checkout setup](engdocs/development.md#setup) for installation from source. Runtime commands describe themselves through `bl -h`, `bl help`, `bl prime OP` and `botlake -h`.

## Manifest and workspace selection

Initialize a workspace without installing packages or selecting extensions:

```sh
botlake init --workspace /absolute/workspace --name work
```

Configuration lives in `.botlake/package.json`. Its required `botlake` object accepts only `name` and `extensions`; other package fields remain ordinary Bun package configuration:

```json
{
  "private": true,
  "type": "module",
  "botlake": {
    "name": "work",
    "extensions": ["@botlake/extension-batteries", "./.botlake/priming.ts"]
  }
}
```

`name` defaults to the workspace directory basename, not the package name. An explicit name starts with a letter and contains only letters, digits, underscores or hyphens; active lake names must be unique. Omitted or empty `extensions` activates no domains.

CLI workspace selection is `--workspace PATH|NAME`, then nonempty `BL_WORKSPACE`, then Git discovery. Git discovery uses the main checkout's configuration and `.botlake/world.db`, shared by subdirectories and linked worktrees; worktree-local configurations are ignored. Outside Git, set `BL_WORKSPACE` or pass `--workspace`. Published names select active lakes; a new lake needs a path.

An explicit selection stays in effect across directory changes. `bl --cwd DIR` and `botlake lake eval --cwd DIR` set invocation context, but only select that directory's lake when neither `--workspace` nor `BL_WORKSPACE` is set. An unavailable selected workspace fails rather than falling back to the current directory's lake.

## Packages and extension selection

Packages export Bun-native TypeScript without a build step and are not published. Run `bun pm pack` inside each source package to create a local tarball; Bun rewrites workspace dependency ranges. Install core and chosen extensions into the workspace or its `.botlake` package. For offline tarball installs, point both consumer `dependencies` and `overrides` at the tarballs for every `@botlake/*` peer.

- Package entries resolve from `.botlake`; relative entries resolve from the workspace root. Absolute module paths also work.
- Each selected entry must default-export an `Extension`.
- Installed package dependencies and selected extension prerequisites are separate: explicitly select every required extension, in any order.
- Installation and imports do not activate extensions. Activation registers operations; resources start after dependency and collision validation.

Extension-owned factories, options and prerequisites are described in each extension's README. Available source packages live under [extensions](../extensions/).

## Configured local modules

Call an existing factory from a local module when an extension needs options. For example, save this as `.botlake/priming.ts` for the manifest above:

```ts
import { priming } from "@botlake/core";

export default priming({
  events: "Document new event contracts before publishing them.",
});
```

This appends workspace guidance to the core `events` primer. See [priming](../packages/core/README.md#priming) for the configuration contract.

Select the configured module instead of the same extension's unconfigured package entry; selecting both causes an extension-name collision. Keep modules under `.botlake` when their imports are installed there: a workspace-root module does not inherit `.botlake/node_modules` resolution. Extension options belong to the factory, not additional fields in `botlake` configuration.

Configuring a factory is distinct from [authoring a new extension](../packages/core/README.md#extension-authoring).

## Applying configuration

With a supervisor running (`botlake start` in a separate terminal), start an inactive lake by path:

```sh
botlake lake start --workspace /absolute/workspace
```

After editing the manifest, configured modules or lake environment, use `botlake lake restart --workspace /absolute/workspace`. Calling `start` on an already-running lake does not reload it. `botlake lake info --workspace work` reports the loaded snapshot and extension README/source locations, not pending edits.

## Environment

- `BL_WORKSPACE` selects the default lake independently of cwd; `--workspace` overrides it. Use an absolute workspace directory when sharing the environment with native session adapters, which require a path. Managed agents receive their owning lake's absolute path automatically.
- `BL_HOME` selects the supervisor and retained-output directory (default `~/.botlake`), not the workspace database location.
- `BL_CORE` selects an installed core package directory for the host and evaluator; the default is the CLI's source checkout.
- `ctx.env.lake` captures the environment supplied at lake start/restart; host recovery retains it. Use this for extension startup configuration.
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
