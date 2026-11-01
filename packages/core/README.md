# @botlake/core

Bun-native lake engine: graph/attributes, atomic mutations and guards, typed Standard Schema operations, activation, events, durable wakes and pooled workspace workers. No extension dependencies or default domain commands.

Node IDs are opaque, immutable and lake-local. New nodes use three digits and two words, such as `042-apple-cloud`; allocation retries collisions and never reuses burned IDs. `Graph.lakeId` is a persisted database UUID, independent of workspace names and routes. `Runtime` supplies secure randomness; standalone `Graph` instances take a `nextId` function, such as `() => nodeId(randomInt)` with Node's `crypto.randomInt`. The fixed word list is attributed in [NOTICE](NOTICE).

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

`defineOp` accepts Standard Schema v1 input/output validators. CLI metadata and optional JSON Schema export remain independent: `help` discloses syntax one level at a time, while `schema OP` exports only the declared schemas. `about OP` and `prime OP` carry concepts and runbooks. Operations default to a 30s deadline. `deadline: "unbounded"` lets a long-running operation own its wait budget; an explicit caller timeout still overrides it. Handlers must observe `request.signal` and clean up pending I/O or timers on abort. `request.deadline` is an absolute clock time, or `null` without a request deadline. `Context` provides graph, clock, scheduler, processes and peers; Botlake supplies custody/routing when running workers. `peers.resolve(pathOrName)` returns the published canonical path/name; `peers.call` invokes a single-result operation without transport replay and rejects streams.

`peers.resolve` and `peers.call` accept `{ signal, timeoutMs }`, defaulting to a 30-second deadline. Calls retain structured owner faults and close the request on cancellation. `peers.watch(workspace, events, signal)` streams committed notifications; wait for ready before a snapshot and refetch after reconnect. It owns no replay or reconnect policy.

`Node.reference` is null for owned nodes; references carry source identity, routing and observed facts outside attributes. `graph.observeReference(source, snapshot)` imports a read-only core summary; null records confirmed absence of an existing reference. `graph.reference(lakeId, nodeId)` finds one import. `graph.references` filters/pages metadata before hydration; `graph.snapshots(ids)` returns owned core summaries and `graph.summaries(ids)` also includes reference provenance. Generic mutations cannot edit reference facts. Reopening the graph invalidates persisted live observations. The opt-in [References extension](../../extensions/references/README.md) owns subscriptions and domain projections.

`graph.forgetReference(id)` deliberately removes a local import; generic burn and batch deletion reject it. A `depends-on` edge can declare `dependencyAttributes.referenceKinds`, a nonempty list of accepted source projection kinds. Generic readiness then requires the reference to be current, closed and match that constraint. Work supplies its own accepted kinds; Core knows no domain kind names.

Read `ctx.env.lake` for the environment captured by `botlake lake start|restart`, and `ctx.env.bl` inside an operation for the invoking `bl` or lake eval caller's environment. The namespaces stay separate, including overlapping calls and streams; missing keys are `undefined`. Activation has an empty `env.bl`. Host recovery retains each lake's environment; an explicit lake restart captures it again. Embedded runtimes accept `env` in both the `Runtime` constructor and `invoke` options.

Workspace configuration lives in the required `botlake` field of `.botlake/package.json`. It accepts only optional `name` and `extensions` (default `[]`); the lake name defaults to the workspace directory basename, not the package name. `loadWorkspace` resolves package names from `.botlake` and relative file paths from the workspace root. The same manifest can own configuration dependencies. `workspaceSchema` and `configJsonSchema()` describe the manifest, allowing other package fields while keeping `botlake` strict. The `@botlake/core/host` and `@botlake/core/eval` entries are the Bun host and caller-side evaluator used by Go Botlake; `BL_CORE` selects the installed package directory.

`ctx.bin(name, { description, exec: { path, env? } | { command, env? }, build?: { argv, cwd } })` declares an executable. Paths and build directories are absolute; use the extension’s module location to resolve bundled assets. Commands are bare names resolved through the caller’s PATH. `bins list|plan` exposes the registry; Botlake performs builds and local terminal execution. Registration never launches or builds programs.

## Attribute mutations

`graph.update(id, { title?, state?, attributes?, expectedRevision? })` applies a merge patch: attribute objects merge recursively, arrays/scalars replace, and null deletes keys.

`graph.setAttributes(id, values, expectedRevision?)` replaces each supplied attribute value verbatim, including objects and nulls; omitted keys remain unchanged. Use it for authored JSON, observations and whole documents. Both methods enforce revisions, guards and immutable keys atomically.

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

`graph.count({ where, params, ready, limit })` counts matching nodes without hydrating attributes. With a positive safe-integer `limit`, it returns at most that many matches; reaching the limit is a lower bound, not an exact total. Without a limit it counts all matches.

`graph.list({ where, params, ready, limit, offset })` returns nodes ordered by creation time then ID (default limit 100, maximum 10,000; offset defaults to 0). `graph.all` is the explicit unbounded read.

`graph.list/all` omit archived attributes from results unless `includeArchived: true` is supplied. `graph.show(id, { includeArchived })` and `graph.subgraph(id, relation, { includeArchived })` default to full reads, including archived attributes.

Selection ignores archived attributes even with `includeArchived: true`. Attribute comparisons—including negation—require present, non-null values; `missing` includes absent, archived and null paths. Builders produce data, not JavaScript callbacks executed by the lake.
