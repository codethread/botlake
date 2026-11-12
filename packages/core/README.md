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

## Extension authoring

Extensions default-export `{ name, source?, requires?, activate(ctx) }`. Set `source: import.meta.url` in the defining factory to retain package provenance when a consumer selects a local configuration wrapper. Without `source`, the selected module is the origin. `activate` registers operations, queries, guards, subscriptions and resources using the explicit context. Dependencies name other selected extensions; they never auto-activate. Activation follows prerequisite order; duplicate, missing or cyclic selections fail before activation. Resource startup follows registration/validation; failed startup and shutdown dispose started resources.

`botlake lake info [--workspace PATH|NAME]` returns the running lake's loaded configuration snapshot, including the supervisor's loaded `coreVersion` and the manifest's `minimumCore` (`null` when absent). Each extension includes its runtime `name` (not its package name), package `description` (`null` when absent), configured `specifier`, resolved `module`, defining `source`, nearest `packageJson` and package-root `readme` paths. Paths are absolute; absent manifests or READMEs are `null`. Configuration edits appear after restart. `loadWorkspace(path)` exposes the same metadata as `info` alongside `config` and `extensions`.

### Runtime bindings

Use `runtimeExtension({ name, source?, requires?, activate(ctx) })` when other extensions need a typed runtime implementation. The callback registers the extension and returns its public implementation (or a promise); the factory returns `RuntimeExtension<T>`, an ordinary selectable extension with `instance(ctx): T`.

```ts
import { runtimeExtension } from "@botlake/core";

export const records = runtimeExtension({
  name: "records",
  source: import.meta.url,
  activate(ctx) {
    return { count: () => ctx.graph.count() };
  },
});
```

Configuration creates each binding once and passes that same object to consumers. Consumers declare `requires: [records.name]` and resolve `records.instance(ctx)` during activation. Lookup never constructs or activates anything; before successful activation, or when a different same-name binding was selected, it throws. A shared binding produces separate implementations for separate contexts. Importing a binding does not select it or its prerequisites.

The implementation is available after awaited activation, before resource startup. Start background work through `ctx.resource`; binding access does not establish readiness or extend the runtime lifetime. The binding holds executable wiring, not durable records: store runtime facts in the database. Workspace loading retains activation descriptors; consumers use their original imported configuration bindings, not descriptors recovered from `loadWorkspace().extensions`.

### Operations

Use `isFault(error)` to recognize core faults across separately installed package copies.

`defineOp` accepts Standard Schema v1 input/output validators. Omit `cli` for a JSON-only peer operation: input/output validation and deadlines still apply, while argv invocation and CLI discovery are unavailable. This controls presentation, not access. CLI metadata and optional JSON Schema export remain independent: `help` discloses syntax one level at a time, while `schema OP` exports only the declared schemas. `about OP` and `prime OP` carry concepts and runbooks. Operations default to a 30s deadline. `deadline: "unbounded"` lets a long-running operation own its wait budget; an explicit caller timeout still overrides it. Handlers must observe `request.signal` and clean up pending I/O or timers on abort. `request.deadline` is an absolute clock time, or `null` without a request deadline. `Context` provides graph, clock, scheduler, processes and peers; Botlake supplies custody/routing when running workers. `peers.resolve(pathOrName)` returns the published canonical path/name; `peers.call` invokes a single-result operation without transport replay and rejects streams.

For example, a module can register a CLI-visible operation:

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
  source: import.meta.url,
  activate(ctx) {
    ctx.register(length);
  },
} satisfies Extension;
```

[Compile final Zod schemas](https://zod.dev/compile) after refinements or extensions; derived schemas need compiling again. Unsupported features such as recursion retain Zod's runtime parser. Select the module through [workspace configuration](../../docs/usage.md#packages-and-extension-selection).

`peers.resolve` and `peers.call` accept `{ signal, timeoutMs }`, defaulting to a 30-second deadline. Calls retain structured owner faults and close the request on cancellation. `peers.watch(workspace, events, signal)` streams committed notifications; wait for ready before a snapshot and refetch after reconnect. It owns no replay or reconnect policy.

### Priming

Import `brief` from `@botlake/core` for a short, extension-independent CLI orientation to embed in agent prompts.

Select `priming({ operation: addition })` once to append consumer guidance to CLI-visible operation primers. An addition is a string or synchronous `PrimerCallback(ctx, invocation)`; callbacks run only for `prime OP`, receive that request's normalized caller and invocation coordinates, and may return blank text to add nothing. Author guidance remains first. Unknown, metadata-only and duplicate targets fail at startup, including duplicate priming selections.

### References

`Node.reference` is null for owned nodes; references carry source identity, routing and observed facts outside attributes. `graph.observeReference(source, snapshot)` imports a read-only core summary; null records confirmed absence of an existing reference. `graph.reference(lakeId, nodeId)` finds one import. `graph.references` filters/pages metadata before hydration; `graph.snapshots(ids)` returns owned core summaries and `graph.summaries(ids)` also includes reference provenance. Generic mutations cannot edit reference facts. Reopening the graph invalidates persisted live observations. The opt-in [References extension](../../extensions/references/README.md) owns subscriptions and domain projections.

`graph.forgetReference(id)` deliberately removes a local import; generic burn and batch deletion reject it. A `depends-on` edge can declare `dependencyAttributes.referenceKinds`, a nonempty list of accepted source projection kinds. Generic readiness then requires the reference to be current, closed and match that constraint. Work supplies its own accepted kinds; Core knows no domain kind names.

### Workspace configuration

Read `ctx.env.lake` for the environment captured by `botlake lake start|restart`, and `ctx.env.bl` inside an operation for the invoking `bl` or lake eval caller's environment. The namespaces stay separate, including overlapping calls and streams; missing keys are `undefined`. Activation has an empty `env.bl`. Host recovery retains each lake's environment; an explicit lake restart captures it again. Embedded runtimes accept `env` in both the `Runtime` constructor and `invoke` options.

Workspace configuration is an inert `LakeDefinition` exported as `lake` from `.botlake/lake.ts`; `.botlake/package.json` owns its ordinary Bun dependencies. `createLake` preserves the selected extension values, optional `name` and optional `minimumCore`. The name defaults to the workspace directory basename. Each standalone lake launches the runner and caller-side evaluator from its own installation, so its lockfile pins core and extension versions independently.

### Executables

`ctx.bin(name, { description, exec: { path, env? } | { command, env? }, build?: { argv, cwd } })` declares an executable. Paths and build directories are absolute; use the extension’s module location to resolve bundled assets. Commands are bare names resolved through the caller’s PATH. `bins list|plan` exposes the registry; Botlake performs builds and local terminal execution. Registration never launches or builds programs. Keep the extension entry point loadable before its bins are built. A build recipe must work from the installed package's own sources and declared dependencies, not an assumed source checkout; callers explicitly use `botlake bin build NAME` before running it.

## Events

Declare typed handles in an extension's `events.ts` with `defineEvent({ name, phase, schema })`, register them during activation with `ctx.registerEvent`, and use `ctx.on` / `ctx.emit`. Transactional handlers are synchronous, return no value and join the current `graph.atomic`; errors roll it back. After-commit observers may be asynchronous; their failures are recorded in `Runtime.errors`. Subscriptions belong to one lake and return an unsubscribe function.

## Attribute mutations

`graph.update(id, { title?, state?, attributes?, expectedRevision? })` applies a merge patch: attribute objects merge recursively, arrays/scalars replace, and null deletes keys.

`graph.setAttributes(id, values, expectedRevision?)` replaces each supplied attribute value verbatim, including objects and nulls; omitted keys remain unchanged. Use it for authored JSON, observations and whole documents. Both methods enforce revisions, guards and immutable keys atomically. `graph.isImmutable(key)` lets publishers reject declared immutable fact keys before applying authored attributes.

## Queries

`q` constructs serializable predicates for `graph.list/all`, named queries and [Botlake eval](#javascript-evaluation). Declarations stay inert; register them inside the selected extension’s `activate`:

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

## JavaScript evaluation

`botlake lake eval` exposes `q` and `api.call(OP, INPUT, { identity? })` to a caller-side async function body. A per-call identity overrides the caller's `BL_ACTOR`; omitting it forwards that caller identity. See `botlake help lake eval` for source forms, bindings, output and security semantics.

The overall deadline includes synchronous loops and all operation calls. Timeout enforcement terminates the evaluator process; completed operations are not rolled back.
