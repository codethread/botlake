# @botlake/core

Bun-native lake engine: graph/attributes, atomic mutations and guards, typed Standard Schema operations, activation, events, durable wakes and pooled workspace workers. No extension dependencies or default domain commands.

```ts
import { Runtime, type Extension } from "@botlake/core";

const selected: Extension[] = []; // Import only the extensions this lake needs.
const runtime = new Runtime({ database: "/absolute/workspace/world.db" });
try {
  await runtime.start(selected);
  // Use runtime.graph or runtime.invoke(name, input).
} finally {
  await runtime.stop();
}
```

Extensions default-export `{ name, requires?, activate(ctx) }`. `activate` registers operations, queries, guards, subscriptions and resources using the explicit context. Dependencies name other selected extensions; they never auto-activate. Activation follows prerequisite order; duplicate, missing or cyclic selections fail before activation. Resource startup follows registration/validation; failed startup and shutdown dispose started resources.

Use `isFault(error)` to recognize core faults across separately installed package copies.

`defineOp` accepts Standard Schema v1 input/output validators. CLI metadata and optional JSON Schema export remain independent. `Context` provides graph, clock, scheduler, processes and peers; Botlake supplies custody/routing when running workers. `peers.resolve(pathOrName)` returns the published canonical path/name; `peers.call` invokes a single-result operation without transport replay and rejects streams.

Read `ctx.env.lake` for the environment captured by `botlake lake start|restart`, and `ctx.env.bl` inside an operation for the invoking `bl` or lake eval caller's environment. The namespaces stay separate, including overlapping calls and streams; missing keys are `undefined`. Activation has an empty `env.bl`. Host recovery retains each lake's environment; an explicit lake restart captures it again. Embedded runtimes accept `env` in both the `Runtime` constructor and `invoke` options.

Workspace configuration lives in the required `botlake` field of `.botlake/package.json`. It accepts only optional `name` and `extensions` (default `[]`); the lake name defaults to the workspace directory basename, not the package name. `loadWorkspace` resolves package names from `.botlake` and relative file paths from the workspace root. The same manifest can own configuration dependencies. `workspaceSchema` and `configJsonSchema()` describe the manifest, allowing other package fields while keeping `botlake` strict. The `@botlake/core/host` and `@botlake/core/eval` entries are the Bun host and caller-side evaluator used by Go Botlake; `BL_CORE` selects the installed package directory.

`ctx.bin(name, { description, exec: { path, env? } | { command, env? }, build?: { argv, cwd } })` declares an executable. Paths and build directories are absolute; use the extension’s module location to resolve bundled assets. Commands are bare names resolved through the caller’s PATH. `bins list|plan` exposes the registry; Botlake performs builds and local terminal execution. Registration never launches or builds programs.

## Queries

`q` constructs serializable predicates for `graph.list/all`, named queries and [Botlake eval](../../README.md#javascript-evaluation). Declarations stay inert; register them inside the selected extension’s `activate`:

```ts
import { q, type NamedQuery } from "@botlake/core";

const open = q.eq("state", "active");
const byOwner = {
  description: "Active nodes with the supplied owner",
  params: ["owner"],
  where: q.and(open, q.eq(q.attr("work/owner"), q.param("owner"))),
} satisfies NamedQuery;

// Inside activate(ctx):
ctx.registerQuery("open-by-owner", byOwner);
```

Builders: `and`, `or`, `not`; `eq`, `ne`, `lt`, `lte`, `gt`, `gte`, `inArray`; `exists`, `missing`; `edgeOut`, `edgeIn`. String fields name node columns; `q.attr(key, ...path)` selects an attribute or nested JSON value. `q.param(name)` binds through `params`; `inArray` accepts a nonempty array or parameter. Edge predicates test the opposite endpoint and cannot contain another edge predicate.

Selection ignores archived attributes. Attribute comparisons—including negation—require present, non-null values; `missing` includes absent, archived and null paths. Builders produce data, not JavaScript callbacks executed by the lake.
