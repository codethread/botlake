# Opt-in lake pool contract

Pools are an optional deployment optimization after the standalone topology. Standalone remains the default and the semantic reference. Pooling changes fault and isolation properties, not lake behavior or the public invocation protocol.

## Admission and artifact identity

A pool runs one pinned Botlake runner package artifact in one Bun process and one Worker per member. The supervisor may admit a lake only when all of these are true:

- its configuration explicitly names that pool; absence of a pool selection means standalone;
- its installed runner resolves to the pool's exact artifact identity (package version plus lockfile/integrity identity), and its required Bun version matches the pool;
- every selected extension and configuration dependency resolves from that artifact's install;
- the lake accepts the pool's launch environment and fixed process working directory contract;
- its canonical database path is distinct from every other member and the supervisor can acquire that member's exclusive database lease for transfer to the pool process.

Do not combine merely semver-compatible installations. A pool has one package graph, so a lake needing another core, extension version, native module build or dependency patch belongs in another pool or remains standalone. Names and canonical paths remain globally unique across standalone lakes and all pools.

The configuration and extensions are trusted Worker code. Pool eligibility requires them not to call `process.chdir`, mutate `process.env`, install process-wide signal/exception handlers, monkey-patch globals, or depend on process exit for cleanup. This is a declared operational property, not an isolation guarantee that Botlake can completely inspect.

## Environment and working directories

The pool process starts once with an immutable launch environment and a fixed cwd in the pool artifact directory. Members do not receive distinct `process.env` or process cwd values. Configuration, activation and operations use `ctx.env.lake`, `ctx.env.bl` and invocation `cwd` instead. A member that requires a different launch environment or ambient cwd is ineligible for that pool.

Restarting one member reloads its trusted configuration but does not refresh the pool process environment or cwd. Changing either requires a whole-pool restart. Invocation environments remain per-call values and must never be copied into process globals.

## Per-member lifecycle

The Go supervisor retains routing, generations, admission and process custody. For each admission it acquires the canonical database lease, passes the descriptor to the pool process and closes its own copy after successful spawn/transfer. The pool process is then the sole descriptor owner. Each member retains the standalone lifecycle state machine and has its own:

- canonical database lease and generation;
- prepare, activate, ready and drain transitions;
- invocation admission lock, cancellation set and typed lifecycle outcomes;
- SQLite runtime, scheduler/resources and readiness metadata.

A call is sent once. Closing one member's admission produces the same `not-admitted` or `uncertain` delivery result as standalone restart/stop. Results from an old generation cannot reach a replacement generation. Pooling does not introduce replay.

For member restart, the pool closes that member's admission, drains it under the standalone soft deadline, stops its runtime and verifies Worker exit before constructing the replacement Worker. The pool process keeps that member's lease descriptor across a successful in-process restart. On member stop it closes the descriptor only after the runtime and Worker have stopped. Failure to prove Worker termination escalates to a whole-pool process restart, whose exit releases every lease descriptor. Siblings continue only when member termination is proven safe.

A member startup or activation failure removes only that member's route and allows explicit retry. An unexpected Worker exit removes and may replace only that member. A pool process crash, fatal process-global exception, OOM, forced process kill, Bun defect or pool environment/artifact change makes every member unavailable. The supervisor must remove all affected routes, classify admitted calls as transport failures unless a deliberate drain already supplied a lifecycle outcome, reap the process, reacquire every per-member lease, and start a fresh pool. No member is reported ready until its own handshake completes.

Supervisor shutdown drains pool members concurrently, then stops the pool process. A requested whole-pool restart closes admission for every member before draining so no lake appears isolated from that operation.

## Isolation statement

Workers isolate JavaScript heaps and event loops, and separate SQLite connections preserve database ownership. Workers are not OS process isolation. They share process memory accounting, file-descriptor limits, environment, cwd, signals, native-library state and process fate. Native crashes and resource exhaustion therefore have pool-wide blast radius.

Do not pool high-risk native extensions, untrusted configuration, lakes requiring independent ambient state, or lakes whose availability must survive a sibling's process-level failure. Use standalone processes for those cases.

## Disposable comparison

The two checked-in reports use 24 disposable packed lakes, real SQLite databases and the same load: 20 transactions of 100,000 updates in one lake while probing unaffected siblings and restarting another member.

| Measurement                             | Standalone processes | Shared process Workers |
| --------------------------------------- | -------------------: | ---------------------: |
| Total/member-host RSS                   |           1341.6 MiB |              487.1 MiB |
| Approximate RSS per member              |      median 63.3 MiB |   incremental 18.8 MiB |
| Total serial startup                    |            1582.7 ms |              1064.0 ms |
| Member startup median / p95             |       62.1 / 89.4 ms |         43.7 / 47.7 ms |
| Sibling latency median / p95 under load |       1.56 / 3.24 ms |         1.78 / 4.09 ms |
| Member restart under load               |              66.2 ms |                46.1 ms |
| Process failure blast radius            |             one lake |      every pool member |

The shared-process report predates the standalone cutover and exercised the former one-host/one-Worker-per-workspace implementation. Its topology is recorded from the original measurement description; the current reproduction command does not recreate it. It is retained as a disposable design probe, not as supported runtime behavior or a performance promise. The current standalone report establishes the post-cutover baseline on the same machine and Bun version.

RSS accounting is directional rather than directly comparable: the standalone total sums per-process RSS and may count shared physical pages more than once, while the pooled total is one process RSS and its per-member figure subtracts the host baseline. The results justify further implementation work to test a likely memory/startup optimization, not a production savings claim or a change to the default. Any savings would purchase a larger failure domain and stricter artifact/environment constraints.

Reproduce the standalone result with:

```sh
bun scripts/benchmark.ts 24
```

Revalidate both topologies before implementing pools, including a noncooperative Worker that forces process escalation and a deliberate pool-process kill that proves all routes and leases are recovered together.
