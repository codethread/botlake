# @millstrand/core

Bun-native weaver engine: graph/attributes, atomic mutations and guards, typed Standard Schema operations, activation, events, durable wakes and pooled workspace workers. No spool dependencies or default domain commands.

```ts
import { Runtime, type Spool } from "@millstrand/core";

const selected: Spool[] = []; // Import only the spools this weaver needs.
const runtime = new Runtime({ database: "/absolute/workspace/world.db" });
try {
  await runtime.start(selected);
  // Use runtime.graph or runtime.invoke(name, input).
} finally {
  await runtime.stop();
}
```

Spools default-export `{ name, requires?, activate(ctx) }`. `activate` registers operations, queries, guards, subscriptions and resources using the explicit context. Dependencies name other selected spools; they never auto-activate. Activation follows prerequisite order; duplicate, missing or cyclic selections fail before activation. Resource startup follows registration/validation; failed startup and shutdown dispose started resources.

Use `isFault(error)` to recognize core faults across separately installed package copies.

`defineOp` accepts Standard Schema v1 input/output validators. CLI metadata and optional JSON Schema export remain independent. `Context` provides graph, clock, scheduler, processes and peers; Mill supplies custody/routing when running workers. `peers.resolve(pathOrName)` returns the published canonical path/name; `peers.call` invokes a single-result operation without transport replay and rejects streams.

Workspace config accepts only `name` and `spools` (default `[]`). `loadWorkspace` resolves package names from `.millstrand` and relative file paths from the workspace root. A private `.millstrand/package.json` can own configuration dependencies without exporting them from the application. `configJsonSchema()` exports that schema. The `@millstrand/core/host` entry is the Bun host used by Go Mill; `MILLSTRAND_CORE` selects the installed package directory.

`ctx.bin(name, { description, exec: { path, env? } | { command, env? }, build?: { argv, cwd } })` declares an executable. Paths and build directories are absolute; use the spool’s module location to resolve bundled assets. Commands are bare names resolved through the caller’s PATH. `bins list|plan` exposes the registry; Mill performs builds and local terminal execution. Registration never launches or builds programs.
