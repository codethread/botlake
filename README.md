# Botlake

A programmable lake of connected nodes. Each lake owns a Bun worker, SQLite connection, configuration and independently selected extensions. The Go `botlake` CLI supervises lakes and launched processes; `bl` invokes structured data operations with JSON/NDJSON results. Trusted JavaScript evaluation and process execution stay in `botlake`, not `bl`.

Canonical origin: [millstrand](https://github.com/codethread/millstrand).

## Packages

| Package | Owns | Required selected extensions |
| --- | --- | --- |
| [`@botlake/core`](packages/core/README.md) | Graph, operations, activation, events, durable wakes, workers | None |
| [`@botlake/extension-batteries`](extensions/batteries/README.md) | Everyday graph commands | None |
| [`@botlake/extension-identity`](extensions/identity/README.md) | Native session identity and attribution | None |
| [`@botlake/extension-diary`](extensions/diary/README.md) | Identity-owned working history | Identity |
| [`@botlake/extension-flags`](extensions/flags/README.md) | Persistent workspace-local flags with configured defaults | None |
| [`@botlake/extension-agents`](extensions/agents/README.md) | Providers, tracked runs, native observations, custody reconciliation | Identity, Flags |
| [`@botlake/extension-work`](extensions/work/README.md) | Tasks, groups, prerequisites, assignment, closure | Identity |
| [`@botlake/extension-work-agents`](extensions/work-agents/README.md) | Explicitly bound agent-assignment liveness | Work, Agents, Identity |
| [`@botlake/extension-workflow`](extensions/workflow/README.md) | Authored XState workflows projected into Work | Identity, Work |
| [`@botlake/extension-cron`](extensions/cron/README.md) | Calendar/interval jobs, policies and occurrence history | None |

Core does not import or install extensions. Extensions import core and sibling public APIs through declared package dependencies, never relative source paths; Oxlint enforces the boundary. Core is a peer dependency of each extension; Identity is also a peer of Agents, Diary, Work and Workflow; Flags is a peer of Agents; Work is a peer of Work Agents and Workflow. Installation does not imply activation.

Packages export Bun-native TypeScript without a build step. Run `bun pm pack` inside a package to create its standalone tarball; Bun rewrites workspace dependency ranges for publication. These package names are publishing coordinates, not a claim that they are already on a registry. For offline tarball installs, set consumer `overrides` for every `@botlake/*` peer to its tarball path as well as listing it in `dependencies`.

## Run from this checkout

Requires Bun and Go (see `packageManager` and `cli/go.mod` for versions).

```sh
bun install
GOBIN="$HOME/.local/bin" go -C cli install ./cmd/botlake ./cmd/bl
export PATH="$HOME/.local/bin:$PATH"
botlake start # Foreground supervisor; leave running in its own terminal.
# In another terminal, from this checkout:
botlake lake start
bl add 'My first node' --attributes '{"stuff":"data"}'
bl list
bl work create 'My first task' --description 'What done means'
bl work list --view available
bl work show ID
```

The installed binaries use this checkout's core; keep the checkout and its dependencies in place. Re-run the Go install command after Go changes. After TypeScript/configuration changes, use `botlake lake restart` (or `botlake restart-host` for host changes).

The private `.botlake` dogfood package uses `workspace:*` dependencies and selects Work, Workflow, Agents, Diary, Flags and Cron. Root `bun install` links everything; no package is published. Git discovery works from subdirectories and linked worktrees; all use the main checkout's configuration and `.botlake/world.db`, ignored by Git. Agents starts no agents automatically, Cron has no jobs until configured, and Work Agents remains an explicit optional configuration.

[Local agents](.botlake/agents.ts) define model seats and role aliases. `grunt` prefers DeepSeek then Luna; `reviewer` prefers Sol then Opus; `oracle` uses Astra. [Flag defaults](.botlake/flags.ts) configure exported `agentFlags` and local DeepSeek/Fable definitions; Claude remains registered but disabled. Managed launches are headless. Explicitly install the [native identity adapter](plugins/identity/README.md) before launching.

```sh
bl agent catalog
bl agent catalog reviewer
bl flag set agents/deepseek false # grunt now selects Luna.
bl agent start --seat oracle --cwd "$PWD" --prompt "Review the architecture; do not edit files."
bl await --query agent-run-settled --params '{"runId":"RUN_ID"}' --min-count 1
bl agent show RUN_ID # After reason=satisfied; inspect execution outcome, not just settlement.
```

Flags are lake-local; database overrides survive restarts. Use `bl flag reset NAME` (or `--all`) to restore configured defaults. They affect new seat selection, not accepted runs. See [catalog authoring](extensions/agents/README.md#catalog-and-routing) and [runtime limits](docs/LIMITS.md).

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
      "@botlake/extension-work",
      "@botlake/extension-workflow",
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
  input: z.compile(z.object({ text: z.string() })),
  output: z.compile(z.number()),
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

Work Agents is configured this way: export `workAgents({ checkIntervalMs })` from a local module rather than selecting the package directly.

[Compile final Zod schemas](https://zod.dev/compile) after refinements or extensions; derived schemas need compiling again. Unsupported features such as recursion retain Zod's runtime parser.

### Zsh completion

Generate the shell script once after installing or upgrading the CLI; generation needs no running lake:

```sh
mkdir -p "${XDG_CACHE_HOME:-$HOME/.cache}/zsh"
botlake completions zsh > "${XDG_CACHE_HOME:-$HOME/.cache}/zsh/botlake.zsh"
```

Source it from `~/.zshrc` **after** your existing `compinit` setup:

```zsh
source "${XDG_CACHE_HOME:-$HOME/.cache}/zsh/botlake.zsh"
```

Only zsh is supported. The generated script registers completion for both `botlake` and `bl`; sourcing it runs no CLI commands. Base `botlake` commands and flags complete offline. Dynamic `bl` completion requires `jq` and a running lake. It reads root help for operation names, then fetches scoped help as each nested command is selected, so subcommands, flags and boolean values follow the selected lake without loading the full command tree. Workspace context from `--workspace` and `--cwd` is preserved. `@file` and named payload paths complete local files. The shell script is cached, not the command catalog.

## Operate

Use `help` for commands, `prime` for the runbook, and `about` for wider context and configuration that specialists may need beyond day-to-day operation.

Discovery is progressive: `bl help` lists operation names and descriptions, while `bl help OP [SUBCOMMAND...]` shows only that level's syntax and immediate children. Machine-readable `bl help --json OP` also includes the operation's declared input/output schemas, or `null` when none were declared; root and subcommand help omit them. `about` and `prime` require an operation and report unavailable command-scoped guidance explicitly. Redirected output remains machine-readable JSON/NDJSON, `--json` forces it, and `NO_COLOR` disables terminal color. `bl --help` lists global flags without a running workspace.

Put global flags before the operation: `--stdin` attaches text referenced as `:stdin`; repeatable `--payload NAME=PATH` attaches files referenced as `:payload/NAME`. `--input JSON|@FILE|-` supplies the entire JSON input (`-` reads stdin). Operation arguments also accept `@file`, resolved from the caller's directory. `--timeout 5s` overrides the operation deadline (normally 30s); `--dry-run` prints the request. Batteries `await` owns its wait budget instead: `--timeout-secs` defaults to 1800 and returns `reason: "timeout"` on expiry, while an explicit global `--timeout` remains a hard error deadline. `--cwd` sets invocation context and the Git discovery directory. `--worktree-root` and `--git-common-dir` override invocation context only, not workspace selection. After the operation, flags belong to the extension; `--` ends its flag parsing.

`botlake init [--workspace DIR] [--name NAME]` adds an empty `botlake` field to `.botlake/package.json`, creating a private module package if missing, without installing or selecting extensions. Without `--workspace`, it initializes the main Git checkout, even from a linked worktree or subdirectory. Existing package fields and selected configuration are preserved. `botlake --version` reports the CLI/build/protocol versions.

`botlake bin list|build|run [--workspace PATH|NAME] [BIN] [ARGS...]` lists, builds or executes extension-declared programs. Runs inherit the caller’s working directory, stdin/stdout/stderr and terminal, overlay the declared environment, and preserve the program’s exit status. All arguments after BIN pass through literally. Builds run only when explicitly requested, in their declared directory.

`botlake lake start|restart|stop|status --workspace PATH|NAME` manages one worker; `botlake lake list` lists published routes. Without `--workspace`, CLI commands read `.git` and linked-worktree `commondir` metadata directly—no Git subprocess—to select the main checkout's `.botlake/package.json` and database, ignoring worktree-local configs. Invocation context still reports the actual worktree. Non-Git directories and layouts whose common directory is not named `.git` require `--workspace`. Explicit paths or published names bypass discovery, allowing isolated lakes. Names default to the workspace directory basename; duplicate names fail before activation. Bare selections prefer published names; explicit paths select paths. Replacement reloads configuration and publishes the new name only after readiness. `botlake status`, `restart-host`, `host-status`, and `stop` manage the daemon/pool.

`BL_HOME` isolates a supervisor and retained output (default `~/.botlake`). Botlake uses this checkout's core by default; set `BL_CORE` to an installed `@botlake/core` package directory to run independently of the checkout's TypeScript packages.

Extensions read the environment supplied to `botlake lake start|restart` through `ctx.env.lake`, and each invoking `bl` or lake eval caller's environment through `ctx.env.bl`. Values stay in their own namespaces; caller values apply only to that invocation.

Extensions declare typed handles in `events.ts` with `defineEvent({ name, phase, schema })`, register them during activation with `ctx.registerEvent`, and use `ctx.on` / `ctx.emit`. Transactional handlers are synchronous, return no value and join the current `graph.atomic`; errors roll it back. After-commit observers may be asynchronous; their failures are recorded in `Runtime.errors`. Subscriptions belong to one lake and return an unsubscribe function.

`bl events list` shows registered payload contracts. `bl events stream [--event NAME ...]` emits committed notifications as JSONL. Wait for `ready` before loading snapshots, invalidate reads on changes, and refetch on reconnect. The stream has bounded buffering and no replay; transactional hooks stay in-process. Work publishes changed IDs, while Agents publishes run IDs and liveness evidence.

Agents supports Codex, Pi and Claude. Native agents own session IDs; [native adapters](plugins/identity/README.md) observe identity and supported activity through the shared `@botlake/native-session` protocol. Missing hooks degrade managed tracking to native output evidence, not fabricated lifecycle data. Nothing installs plugins into user profiles automatically. Identity, activity, process custody and task completion remain distinct.

## JavaScript evaluation

Use `bl list|ready --query NAME --params JSON` for named queries. For ad hoc predicates, joins and projections, run JavaScript against an already-running lake:

```sh
botlake lake eval --workspace work - <<'JS'
const runs = await api.call("list", {
  where: q.and(
    q.eq(q.attr("agent/run"), true),
    q.eq(q.attr("agent/state"), "running"),
  ),
  limit: 20,
});
return runs.map(({ id, title }) => ({ id, title }));
JS
```

`botlake lake eval [--workspace PATH|NAME] [--cwd DIR] [--timeout 5s] CODE|@FILE|-` accepts inline code, a caller-relative file or stdin. Source is a JavaScript async function body, not a module: use `await` and explicitly `return` a JSON value. `q` supplies the [core predicate builders](packages/core/README.md#queries); `api.call(OP, INPUT)` invokes selected operations with JSON input and returns their JSON result. No extensions are implicitly selected; the example requires Batteries. Streams are rejected.

Evaluation runs in a separate local Bun process, never inside the lake. Script output goes to stderr; only the returned JSON goes to stdout. Errors exit nonzero. The default 30s deadline covers execution and all calls, including synchronous loops. Workspace discovery and relative paths use the caller’s directory or `--cwd`; `BL_CORE` selects the evaluator package too.

This is trusted scripting, not a sandbox or read-only access. Scripts have the caller’s OS permissions; operations may mutate data, and completed mutations are not rolled back on error or timeout. Calls are not a shared snapshot. List/ready still default to 100 results (maximum 10,000); do not mistake limited selections for complete join inputs. Their shell flags omit `--where`; programmatic input and `bl --input` still accept predicates.

## Verify

```sh
bun run check
bun run check:go
bun test tests/blackbox
bun scripts/schema.ts workspace
bun scripts/benchmark.ts 24
bun scripts/work-smoke.ts
bun scripts/workflow-smoke.ts
bun scripts/work-agent-smoke.ts
```

Blackbox tests pack and install the packages outside the checkout, then exercise real Go/Bun processes and disposable databases. Schema export also accepts `job`, `agents` or `flags`; each schema is owned by its package. See [Workflow verification](docs/workflow-spike.md), [runtime limits](docs/LIMITS.md) and [pool measurements](docs/pool-benchmark.json).
