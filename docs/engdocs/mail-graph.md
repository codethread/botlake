# Graph Mail verification

Mail uses graph nodes and attributes as its only storage. Optional Mail–Identity owns addressing edges; optional Mail–Agents owns explicit one-shot continuation permissions and composes the configured Agents runtime binding. The dedicated-table prototype was removed after comparison. Its historical measurements remain below; no source, runtime flag or compatibility layer for it is retained.

The reply model takes inspiration from [Beads messaging](https://github.com/gastownhall/beads/blob/main/engdocs/messaging.md): replies point to their parent without requiring a thread entity. CC, rooms and group receipt semantics are outside this change. Public contracts live in the [Mail](../../extensions/mail/README.md), [Mail–Identity](../../extensions/mail-identity/README.md), [Mail–Agents](../../extensions/mail-agents/README.md) and [plugin](../../plugins/mail/README.md) READMEs.

## Reproduction

All scripts create disposable databases/supervisors and clean up in `finally`. Evidence stays under ignored `out/mail-graph/`. Install workspace dependencies first. Full check/test suites use the repository CPU lock.

```sh
bun scripts/mail-graph/smoke.ts
bun scripts/mail-graph/lifecycle-smoke.ts
qlock exec --lock /tmp/agent-cpu.lock -w 60 -- bun run check
qlock exec --lock /tmp/agent-cpu.lock -w 60 -- bun run test
qlock exec --lock /tmp/agent-cpu.lock -w 60 -- bun scripts/mail-graph/benchmark.ts
```

`smoke.ts` exercises real CLI operations: arrival during await, timeout, ack observation, direct/late/idempotent delivery state, atomic recipient receipts, replies, context links, late identity registration, derived-edge ownership, restart, lean paging and no mail-specific tables. `lifecycle-smoke.ts` uses real SQLite and the existing ManualClock/injected-custody pattern to check explicit enrollment, identity, settlement, restart/coalescing, cancellation, expiry, failed runs, completed targets and competing continuations. These are retained smoke scripts rather than temporary implementation unit tests.

Native tests require authenticated Codex and Pi with Luna available. Set `BL_MAIL_PI_BIN` to the native Pi executable when a shell wrapper does not support headless flags; otherwise it defaults to `pi`. Each invocation explicitly loads its required adapters. No global configuration is changed.

```sh
bun scripts/mail-graph/live.ts
bun scripts/mail-graph/lifecycle-live.ts
bun scripts/mail-graph/stress.ts all
bun scripts/mail-graph/stress.ts orchestrator deadline
```

The direct pair verified tokens and acknowledgements across Codex/Pi. The lifecycle pair verified that both native harnesses can arm a wait, exit, receive mail afterward, and resume the same native session/identity to acknowledge mail and save its exact body. The integration does not force agents to arm, and cannot validate task-specific payloads.

## Historical comparison

Measured locally on 2026-11-06 under the CPU lock: 20 registered identities, 20/200/2,000 messages, approximately 1 KiB bodies, one sender and 20 recipients. Each read case had one warm-up and 30 sequential samples; timings include CLI startup and lake RPC. Last-level send measurements contain 1,800 incremental sends. Database sizes are logical SQLite page sizes, excluding WAL/filesystem overhead.

At 2,000 messages, p95 milliseconds (lists return up to 20 rows):

| Storage                 | Send | Received list | Sent list | Read one | Logical MiB |
| ----------------------- | ---: | ------------: | --------: | -------: | ----------: |
| Removed table prototype | 2.70 |          2.91 |      2.86 |     2.55 |        2.91 |
| Graph                   | 3.08 |          5.05 |      5.05 |     2.55 |       12.76 |
| Graph + identity links  | 3.76 |          8.60 |      8.62 |     2.79 |       13.31 |

The linked graph's satisfied await probe was 2.73 ms p95. Lean output reduces payload, but graph hydration still reads body attributes and lists read outgoing edges per row. Startup identity reconciliation scans existing mail. Larger histories, cold-start performance and throughput under concurrent writes remain unmeasured. The current benchmark reruns only the two graph modes.

A temporary panel in the separate Botlake UI worktree exercised received/sent paging, lazy body reads and parent navigation. With 26 messages, actual HTTP received-list latency was 4.22 ms median / 7.03 ms p95 (30 requests). Desktop/narrow light/dark browser checks passed, including explicit refresh and unchanged message state after reading. That UI experiment is separate from this PR. Its fixture remains available as `bun scripts/mail-graph/consumer.ts /absolute/path/to/botlake-ui-checkout`; it uses loopback port 18184, writes a URL into `out/mail-graph/consumer/fixture.json`, and stops on a `stop` file in that output directory or after ten minutes.

## Comparable stress trials

Before adding Mail–Agents, 32 fresh Luna sessions across Codex and Pi repeated the table prototype's workloads in four disposable lakes. Assignments, token checks, seven-minute task budgets and nine-minute runner caps were preserved. Graph agents received the current primer and Batteries await, so this compares the implementations as experienced by agents, not storage alone. Outcomes were captured before all 32 original sessions resumed for unannounced feedback.

| Workload | Table baseline | Graph trial before lifecycle composition |
| --- | --- | --- |
| 12 sequential ping-pong rounds | 24/24 exact messages acknowledged | Same; initiator artifact verified all 12 tokens |
| Seven senders × four items | All 28 items collected; six correct receipts sent, four verified | All 28 items collected exactly; seven correct receipts sent, five verified; two senders exited early |
| Ten workers, natural waiting | Nine valid results; no HOLD phase | Ten valid results; ten HOLDs sent, nine acknowledged; no RELEASE |
| Ten workers, explicit deadline | Eight valid results; no HOLD phase | Full sequence; all 50 actual messages acknowledged, but only 49/50 exact payload matches |

The deadline trial was **not a full task-correctness pass**. A worker's send command omitted a character from its RESULT token; the orchestrator accepted it and incorrectly marked it verified. Mail preserved the supplied body. Worker artifacts and DONE tokens were correct, and timestamps confirmed all HOLD acknowledgements preceded RELEASE. This verifies transport/phase ordering while exposing failed application validation.

Eleven agents executed the documented await pattern (119 calls), including two that still exited early. Some agents requested a wait operation that already existed; several guessed `mail help` instead of `help mail send`. Appended hook notices were sometimes confused with the preceding command's snapshot. Narrative claims also miscounted receipt states. Stored messages and artifacts, rather than self-reported success, determined the outcomes. There were no observed Mail hook failures or runner-cap kills. No product changes were made between those comparison trials.

Graph evidence: `out/mail-graph/stress/2026-11-06T18-27-48.810Z/`, `2026-11-06T18-36-30.870Z/`, and `out/mail-graph/stress-comparison.json`. The subsequent Mail–Agents change addresses explicit waiting across completed turns; its deterministic and native lifecycle smoke results are separate from this historical stress comparison.

## Delivery limits

Delivered means the plugin reports notification handoff, not host-confirmed context consumption. Both harnesses have a crash gap; concurrent hooks may duplicate notices. Unacknowledged messages remain in the inbox, and lifecycle resumption observes pending mail regardless of notification status. Identity is attribution, not authentication. Acknowledgement means seen and never proves agreement, correct payload verification, stopped processes or task completion.
