# Millstrand

A graph and spool runtime in strict TypeScript/Bun, supervised by Go Mill. Each workspace has its own Bun worker, SQLite connection, registries and dependencies. Mill owns launched commands across worker and host replacements.

```sh
bun install
qlock exec --lock /tmp/agent-cpu.lock -w 180 -- bun run build:cli
export PATH="$PWD/out:$PATH"
mill start
mill up /absolute/workspace
strand --workspace work help
```

Create `.millstrand/config.json` in the workspace:

```json
{ "name": "work", "spools": ["batteries", "identity", "harnesses", "kanban", "./spools.ts"] }
```

Select only the spools you use. Dependencies must be explicitly selected. External entries resolve as workspace packages or paths and export a default `{name, requires?, activate(ctx)}`. Imports describe operations/jobs; activation registers them; resources start after dependency and collision validation. A workspace package uses `package.json` and `bun.lock`, with no build step.

```ts
import { defineOp, type Spool } from "millstrand-ts";
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

Use `cron({jobs: [defineJob(...)], actions: {name: async (ctx, occurrence) => ...}})` as another selected spool. Jobs accept an interval or cron expression/IANA timezone, overlap (`skip`, `queue`, `allow`), missed-run (`skip`, `once`, `catch-up`), and retry policy. Actions receive a stable occurrence ID for deduplication. `version` changes explicitly reset a job's configuration; unchanged definitions preserve cadence. Configuration schemas: `bun scripts/schema.ts workspace|job|harnesses`.

`strand help|about|prime|primer OP [SUBCOMMAND...]` discovers commands. `--payload JSON` and `--payload @file.json` supply structured inputs; flags also accept `@file`. `--timeout 5s` sets an invocation deadline. `mill bin BIN --workspace NAME ...` dispatches a spool-declared binary. `mill restart NAME`, `restart-host`, `down NAME`, `status`, and `stop` manage the pool. `MILL_HOME` isolates a daemon and its retained output.

Native identity adapters are delivered in `plugins/identity` (Codex/Claude hooks and Pi extension) and `plugins/cursor`. They are never installed into user profiles automatically. Managed registrations require the current invocation; direct native sessions receive identity and provenance without process ownership. Agent success does not close the served task.

```sh
qlock exec --lock /tmp/agent-cpu.lock -w 180 -- bun run check
qlock exec --lock /tmp/agent-cpu.lock -w 180 -- bun run check:go
qlock exec --lock /tmp/agent-cpu.lock -w 180 -- bun test tests/blackbox
qlock exec --lock /tmp/agent-cpu.lock -w 180 -- bun scripts/benchmark.ts 24
```

Tests use disposable databases/workspaces and real Go/Bun processes. [Port progress and API omissions](docs/PORT.md), [pool measurements](docs/pool-benchmark.json).
