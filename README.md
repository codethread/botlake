# Botlake

A programmable lake of connected nodes. Each lake owns a Bun worker, SQLite connection, configuration and independently selected extensions. The Go `botlake` CLI supervises lakes and launched processes; `bl` invokes structured data operations with JSON/NDJSON results. Trusted JavaScript evaluation and process execution stay in `botlake`, not `bl`.

Canonical origin: [millstrand](https://github.com/codethread/millstrand).

## Packages

| Package | Owns | Required selected extensions |
| --- | --- | --- |
| [`@botlake/core`](packages/core/README.md) | Graph, operations, activation, events, durable wakes, workers | None |
| [`@botlake/extension-batteries`](extensions/batteries/README.md) | Everyday graph commands | None |
| [`@botlake/extension-identity`](extensions/identity/README.md) | Native session identity and attribution | None |
| [`@botlake/extension-flags`](extensions/flags/README.md) | Persistent workspace-local flags with configured defaults | None |
| [`@botlake/extension-harnesses`](extensions/harnesses/README.md) | Providers, tracked runs, assignment, reconciliation | Identity, Flags |
| [`@botlake/extension-kanban`](extensions/kanban/README.md) | Boards, cards/tasks, ownership, peer links | Identity |
| [`@botlake/extension-cron`](extensions/cron/README.md) | Calendar/interval jobs, policies and occurrence history | None |

Core does not import or install extensions. Extensions import core and sibling public APIs through declared package dependencies, never relative source paths; Oxlint enforces the boundary. Core is a peer dependency of each extension; Identity is also a peer of Harnesses and Kanban; Flags is a peer of Harnesses. Installation does not imply activation.

Packages export Bun-native TypeScript without a build step. Run `bun pm pack` inside a package to create its standalone tarball; Bun rewrites workspace dependency ranges for publication. These package names are publishing coordinates, not a claim that they are already on a registry. For offline tarball installs, set consumer `overrides` for core, Identity and Flags to their tarball paths as well as listing them in `dependencies`.

## Run from this checkout

Requires Bun and Go (see `packageManager` and `cli/go.mod` for versions).

```sh
bun install
bun run install:local # Builds and installs botlake and bl into ~/.local/bin.
export PATH="$HOME/.local/bin:$PATH"
botlake start # Foreground supervisor; leave running in its own terminal.
# In another terminal, from this checkout:
botlake lake start
bl add 'My first node' --attributes '{"stuff":"data"}'
bl list
```

The installed binaries use this checkout's core; keep the checkout and its dependencies in place. Re-run `bun run install:local` after Go changes. After TypeScript/configuration changes, use `botlake lake restart` (or `botlake restart-host` for host changes).

The private `.botlake` dogfood package uses `workspace:*` dependencies and selects all shipped extensions. Root `bun install` links everything; no package is published. Git discovery works from subdirectories and linked worktrees; all use the main checkout's configuration and `.botlake/world.db`, ignored by Git. Harnesses starts no agents automatically, and Cron has no jobs until configured.

[Local agents](.botlake/agents.ts) define model seats and role aliases. `grunt` prefers DeepSeek then Luna; `reviewer` prefers Sol then Opus; `oracle` uses Astra and `tui` uses Sol. [Flag defaults](.botlake/flags.ts) enable model families and gate DeepSeek with `seat/allow-china`; Claude remains registered but disabled. Managed launches, including `tui`, are headless. Explicitly install the [native identity adapter](plugins/identity/README.md) before launching.

```sh
bl agent catalog
bl agent catalog reviewer
bl flag set seat/allow-china false # grunt now selects Luna.
bl agent start --seat oracle --cwd "$PWD" --prompt "Review the architecture; do not edit files."
bl agent show RUN_ID
```

Flags are lake-local; database overrides survive restarts. Use `bl flag reset NAME` (or `--all`) to restore configured defaults. They affect new seat selection, not accepted runs. See [catalog authoring](extensions/harnesses/README.md#catalog-and-routing) and [runtime limits](docs/LIMITS.md).

In another workspace, install core and the extensions you need using local tarballs. Run `botlake init --workspace /absolute/workspace --name work`, then select extensions in `.botlake/package.json`:

```json
{
  "private": true,
  "type": "module",
  "botlake": {
    "name": "work",
    "extensions": [
      "@botlake/extension-batteries",
      "@botlake/extension-identity",
      "@botlake/extension-kanban",
      "./extensions.ts"
    ]
  }
}
```

The `botlake` field is required; its `name` is optional and defaults to the workspace directory basename, independently of the package's own `name`. Each extension entry must default-export an `Extension`. Package names resolve from `.botlake`, which can declare its dependencies in the same manifest; normal package lookup also reaches workspace-root dependencies. Relative paths resolve from the workspace root. Omitted or empty `extensions` activates nothing; there are no built-in aliases. Prerequisites must be explicitly selected, in any order. Imports are inert; activation registers operations; resources start only after dependency and collision validation.

Extension-specific configuration belongs to that extension, not core's JSON schema. Use a local module to call a configured factory, then select that module:

```ts
import { defineOp, type Extension } from "@botlake/core";
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
} satisfies Extension;
```

## Operate

`bl help|about|prime|primer OP [SUBCOMMAND...]` discovers commands. Terminal help shows usage, arguments, flags and examples; pipes retain JSON/NDJSON. `--json` forces machine output and `NO_COLOR` disables color. `bl --help` lists global flags without a running workspace.

Put global flags before the operation: `--stdin` attaches text referenced as `:stdin`; repeatable `--payload NAME=PATH` attaches files referenced as `:payload/NAME`. `--input JSON|@FILE|-` supplies the entire JSON input (`-` reads stdin). Operation arguments also accept `@file`, resolved from the caller's directory. `--timeout 5s` sets a deadline; `--dry-run` prints the request. `--cwd` sets invocation context and the Git discovery directory. `--worktree-root` and `--git-common-dir` override invocation context only, not workspace selection. After the operation, flags belong to the extension; `--` ends its flag parsing.

`botlake init [--workspace DIR] [--name NAME]` adds an empty `botlake` field to `.botlake/package.json`, creating a private module package if missing, without installing or selecting extensions. Without `--workspace`, it initializes the main Git checkout, even from a linked worktree or subdirectory. Existing package fields and selected configuration are preserved. `botlake --version` reports the CLI/build/protocol versions.

`botlake bin list|build|run [--workspace PATH|NAME] [BIN] [ARGS...]` lists, builds or executes extension-declared programs. Runs inherit the caller’s working directory, stdin/stdout/stderr and terminal, overlay the declared environment, and preserve the program’s exit status. All arguments after BIN pass through literally. Builds run only when explicitly requested, in their declared directory.

`botlake lake start|restart|stop|status --workspace PATH|NAME` manages one worker; `botlake lake list` lists published routes. Without `--workspace`, CLI commands read `.git` and linked-worktree `commondir` metadata directly—no Git subprocess—to select the main checkout's `.botlake/package.json` and database, ignoring worktree-local configs. Invocation context still reports the actual worktree. Non-Git directories and layouts whose common directory is not named `.git` require `--workspace`. Explicit paths or published names bypass discovery, allowing isolated lakes. Names default to the workspace directory basename; duplicate names fail before activation. Bare selections prefer published names; explicit paths select paths. Replacement reloads configuration and publishes the new name only after readiness. `botlake status`, `restart-host`, `host-status`, and `stop` manage the daemon/pool.

`BOTLAKE_HOME` isolates a supervisor and retained output (default `~/.botlake`). Botlake uses this checkout's core by default; set `BOTLAKE_CORE` to an installed `@botlake/core` package directory to run independently of the checkout's TypeScript packages.

Extensions read the environment supplied to `botlake lake start|restart` through `ctx.env.lake`, and each invoking `bl` or lake eval caller's environment through `ctx.env.bl`. Values stay in their own namespaces; caller values apply only to that invocation.

Harnesses supports Codex, Pi and Claude. Native harnesses own session IDs; [native adapters](plugins/identity/README.md) observe identity and supported activity through the shared `@botlake/native-session` protocol. Missing hooks degrade managed tracking to native output evidence, not fabricated lifecycle data. Nothing installs plugins into user profiles automatically. Identity, activity, process custody and task completion remain distinct.

## JavaScript evaluation

Use `bl list|ready --query NAME --params JSON` for named queries. For ad hoc predicates, joins and projections, run JavaScript against an already-running lake:

```sh
botlake lake eval --workspace work - <<'JS'
const runs = await api.call("list", {
  where: q.and(
    q.eq(q.attr("harness/run"), true),
    q.eq(q.attr("harness/state"), "running"),
  ),
  limit: 20,
});
return runs.map(({ id, title }) => ({ id, title }));
JS
```

`botlake lake eval [--workspace PATH|NAME] [--cwd DIR] [--timeout 5s] CODE|@FILE|-` accepts inline code, a caller-relative file or stdin. Source is a JavaScript async function body, not a module: use `await` and explicitly `return` a JSON value. `q` supplies the [core predicate builders](packages/core/README.md#queries); `api.call(OP, INPUT)` invokes selected operations with JSON input and returns their JSON result. No extensions are implicitly selected; the example requires Batteries. Streams are rejected.

Evaluation runs in a separate local Bun process, never inside the lake. Script output goes to stderr; only the returned JSON goes to stdout. Errors exit nonzero. The default 30s deadline covers execution and all calls, including synchronous loops. Workspace discovery and relative paths use the caller’s directory or `--cwd`; `BOTLAKE_CORE` selects the evaluator package too.

This is trusted scripting, not a sandbox or read-only access. Scripts have the caller’s OS permissions; operations may mutate data, and completed mutations are not rolled back on error or timeout. Calls are not a shared snapshot. List/ready still default to 100 results (maximum 10,000); do not mistake limited selections for complete join inputs. Their shell flags omit `--where`; programmatic input and `bl --input` still accept predicates.

## Verify

```sh
bun run check
bun run check:go
bun test tests/blackbox
bun scripts/schema.ts workspace
bun scripts/benchmark.ts 24
```

Blackbox tests pack and install the packages outside the checkout, then exercise real Go/Bun processes and disposable databases. Schema export also accepts `job`, `harnesses` or `flags`; each schema is owned by its package. [Runtime limits](docs/LIMITS.md), [pool measurements](docs/pool-benchmark.json).
