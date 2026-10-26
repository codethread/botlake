# Millstrand

A Bun workspace monorepo: a graph/weaver runtime, independently installable spools, and Go Mill/strand supervision. Each running workspace owns a Bun worker, SQLite connection, registries and dependency resolution. Mill owns launched commands across worker and host replacements.

## Packages

| Package | Owns | Required selected spools |
| --- | --- | --- |
| [`@millstrand/core`](packages/core/README.md) | Graph, operations, activation, events, durable wakes, workers | None |
| [`@millstrand/spool-batteries`](spools/batteries/README.md) | Everyday graph commands | None |
| [`@millstrand/spool-identity`](spools/identity/README.md) | Native session identity and attribution | None |
| [`@millstrand/spool-harnesses`](spools/harnesses/README.md) | Providers, tracked runs, assignment/review, reconciliation | Identity |
| [`@millstrand/spool-kanban`](spools/kanban/README.md) | Boards, cards/tasks, ownership, peer links | Identity |
| [`@millstrand/spool-cron`](spools/cron/README.md) | Calendar/interval jobs, policies and occurrence history | None |

Core does not import or install spools. Spools import core and sibling public APIs through declared package dependencies, never relative source paths; Oxlint enforces the boundary. Core is a peer dependency of each spool; Identity is also a peer of Harnesses and Kanban. Installation does not imply activation.

Packages export Bun-native TypeScript without a build step. Run `bun pm pack` inside a package to create its standalone tarball; Bun rewrites workspace dependency ranges for publication. These package names are publishing coordinates, not a claim that they are already on a registry. For offline tarball installs, set consumer `overrides` for core and Identity to their tarball paths as well as listing them in `dependencies`.

## Run from this checkout

This repo's private `.millstrand` Bun workspace uses `workspace:*` dependencies and selects all shipped spools for dogfooding. One root `bun install` links everything; it is not part of any public package's exports. From the repo, use `./out/mill weaver start` and `./out/strand help` after starting Mill; workspace discovery works from subdirectories too. The local SQLite database is ignored by Git. Harnesses starts no agents automatically, and Cron has no jobs until configured.

```sh
bun install
bun run build:cli
export PATH="$PWD/out:$PATH"
mill start # Foreground daemon; leave running in its own terminal.
# In another terminal:
mill weaver start --workspace /absolute/workspace
strand --workspace work help
```

In the consumer workspace, install core and the spools you need, using published packages or local tarballs. Run `mill init --workspace /absolute/workspace --name work` to create an empty configuration, then edit `.millstrand/config.json` to select spools:

```json
{
  "name": "work",
  "spools": [
    "@millstrand/spool-batteries",
    "@millstrand/spool-identity",
    "@millstrand/spool-kanban",
    "./spools.ts"
  ]
}
```

Each entry must default-export a `Spool`. Package names resolve from `.millstrand`, which can own its dependencies in a private package; normal package lookup also reaches workspace-root dependencies. Relative paths resolve from the workspace root. Omitted or empty `spools` activates nothing; there are no built-in aliases. Prerequisites must be explicitly selected, in any order. Imports are inert; activation registers operations; resources start only after dependency and collision validation.

Spool-specific configuration belongs to that spool, not core's JSON schema. Use a local module to call a configured factory, then select that module:

```ts
import { defineOp, type Spool } from "@millstrand/core";
import { z } from "zod";

const length = defineOp({
  name: "length",
  input: z.object({ text: z.string() }),
  output: z.number(),
  cli: {
    description: "Count characters",
    positionals: [{ name: "text", type: "string", required: true }],
  },
  handler: ({ text }) => text.length,
});
export default {
  name: "example",
  activate(ctx) {
    ctx.register(length);
  },
} satisfies Spool;
```

## Operate

`strand help|about|prime|primer OP [SUBCOMMAND...]` discovers commands. Terminal help shows usage, arguments, flags and examples; pipes retain JSON/NDJSON. `--json` forces machine output and `NO_COLOR` disables color. `strand --help` lists global flags without a running workspace.

Put global flags before the operation: `--stdin` attaches text referenced as `:stdin`; repeatable `--payload NAME=PATH` attaches files referenced as `:payload/NAME`. `--input JSON|@FILE|-` supplies the entire JSON input (`-` reads stdin). Operation arguments also accept `@file`, resolved from the caller's directory. `--timeout 5s` sets a deadline; `--dry-run` prints the request. `--cwd`, `--worktree-root` and `--git-common-dir` supply invocation context. After the operation, flags belong to the spool; `--` ends its flag parsing.

`mill init [--workspace DIR] [--name NAME]` creates missing workspace configuration without installing or selecting spools. Existing files are preserved. `mill --version` reports the CLI/build/protocol versions.

`mill bin list|build|run [--workspace PATH|NAME] [BIN] [ARGS...]` lists, builds or executes spool-declared programs. Runs inherit the caller’s working directory, stdin/stdout/stderr and terminal, overlay the declared environment, and preserve the program’s exit status. All arguments after BIN pass through literally. Builds run only when explicitly requested, in their declared directory.

`mill weaver start|restart|stop|status --workspace PATH|NAME` manages one worker; `mill weaver list` lists published routes. Without `--workspace`, the CLI finds the nearest ancestor containing `.millstrand/config.json`. Names default to the workspace directory basename; duplicate names fail before activation. Bare selections prefer published names; explicit paths select paths. Replacement reloads configuration and publishes the new name only after readiness. `mill status`, `restart-host`, `host-status`, and `stop` manage the daemon/pool.

`MILL_HOME` isolates a daemon and retained output. Mill uses this checkout's core by default; set `MILLSTRAND_CORE` to an installed `@millstrand/core` package directory to run independently of the checkout's TypeScript packages.

Harnesses supports Codex, Pi, Claude and Cursor. Cursor’s bundled session hook supplies policy context and registers its native identity; Codex, Pi and Claude native identity adapters remain the separate `@millstrand/identity` package in `plugins/identity`. Nothing installs plugins into user profiles automatically. Native identity, process custody and task completion remain distinct.

## Verify

```sh
bun run check
bun run check:go
bun test tests/blackbox
bun scripts/schema.ts workspace
bun scripts/benchmark.ts 24
```

Blackbox tests pack and install the packages outside the checkout, then exercise real Go/Bun processes and disposable databases. Schema export also accepts `job` or `harnesses`; each schema is owned by its package. [Port scope and limitations](docs/PORT.md), [progress](docs/PORT-PROGRESS.md), [pool measurements](docs/pool-benchmark.json).
