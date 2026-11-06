# Graph-native Mail experiment

This prototype keeps mail entirely in Botlake graph nodes, attributes and edges. The dedicated-table reference remains untouched in `/Users/ct/dev/worktrees/botlake-mail-poc` (`poc/identity-mail`). New implementation: `/Users/ct/dev/worktrees/botlake-mail-graph` (`poc/graph-mail`). Temporary consumer: `/Users/ct/dev/worktrees/botlake-ui-mail` (`poc/mail-panel`). No main-branch changes or global plugin activation are needed.

## Model and boundaries

Mail owns its attributes and lifecycle. One message stores one body; `mail/replies-to` points from a reply to its parent, and optional `mail/about` links context such as a task or run. The separately selected Mail–Identity composition adds `mail/sent-by` and `mail/sent-to` edges, including when identities register after mail arrives. Core identity strings remain the routing source; Identity registration and Agents are optional.

The design borrows nonblocking reply relationships from [Beads messaging](https://github.com/gastownhall/beads/blob/main/engdocs/messaging.md) and [graph links](https://github.com/gastownhall/beads/blob/main/docs/core-concepts/graph-links.md). It does not adopt a separate thread entity, multi-recipient receipts, subscriptions, rooms or agent resumption. Beads' current [mail command](https://github.com/gastownhall/beads/blob/main/cmd/bd/mail.go) delegates to an orchestrator; that runtime integration is not part of this prototype.

[Mail's public API](../../extensions/mail/README.md) exposes lean, paginated operations and named graph queries. Batteries await can observe those queries directly. The primer owns the read/acknowledgement policy; harness notifications contain sender, subject and urgency only. Delivery state suppresses repeated notifications without a second cursor store. Parallel hooks can still duplicate a notification, and plugin-reported delivery is not proof that the model read it.

## Disposable verification

`scripts/mail-graph/smoke.ts` exercises actual CLI operations against temporary SQLite lakes: mail arriving during await, timeout, awaiting acknowledgement, direct acknowledgement without delivery, late delivery receipts, idempotence, atomic rejection of a batch containing another recipient's mail, reply/context queries, late identity registration, restart, lean paging and absence of mail-specific tables. It passed. The existing backend blackbox suite also passed: 63 tests and 1,211 assertions. Type checking, lint and formatting passed.

The live pair ran Luna through native Codex and Pi with explicit invocation-local adapters. Each independently derived its identity, sent an original message with a private token, used existing await, read/acknowledged the other request, replied through `mail reply`, then read/acknowledged its matching reply. Both processes exited zero; all four messages were acknowledged, both original deliveries were recorded, tokens matched and urgent metadata reached Pi. The later stress comparison below repeats the earlier multi-agent workloads separately.

The first live assignment incorrectly required a special `REPLY` subject inherited from the older experiment. The graph reply operation preserves the subject and links by parent ID. Pi used that API while Codex waited for the nonexistent subject; unacknowledged messages also kept satisfying the pending query. We corrected the assignment and primer to correlate `repliesTo` and acknowledge seen messages before another wait. The successful run followed. This illustrates why an await predicate and the acknowledgement protocol must match the task; neither prevents a model from exiting early or proves task completion.

During smoke development, replacing the delivery union through generic JSON merge removed explicit null fields. The implementation now uses graph `setAttributes` for whole-value replacement. The real-database lifecycle checks cover this behavior.

The UI fixture contains 25 received messages across lifecycle states, one urgent item, a reply and registered identities. The panel uses the public Mail API, loads 20 lean rows then five, fetches bodies only on selection, follows a reply's parent, and displays identity links. Chromium checks passed at 1440×1000 and 390×844 in light and dark modes, with no page errors or horizontal page overflow. Explicit refresh and unchanged delivery status after UI reads also passed. The UI full checks passed, including its 20 existing browser tests. The built-in browser was disabled in this environment, so the repository's Playwright tooling was used.

## Measurements

Measured locally on 2026-11-06; no production latency guarantee. The benchmark ran under `/tmp/agent-cpu.lock` without competing quality suites. Each mode used a separate disposable lake with 20 registered identities, 20/200/2,000 messages, approximately 1 KiB bodies, one sender and 20 recipients. Each read case had one warm-up then 30 sequential samples. Timings include CLI process and lake RPC overhead. Send samples are incremental seeding, with 1,800 samples at the last level. Database sizes below are SQLite logical page sizes, not WAL or total filesystem usage.

At 2,000 messages (p95 milliseconds; lists return up to 20 rows):

| Storage | Send | Received list | Sent list | Read one | Logical MiB |
| ------- | ---: | ------------: | --------: | -------: | ----------: |
| table   | 2.70 |          2.91 |      2.86 |     2.55 |        2.91 |
| graph   | 3.08 |          5.05 |      5.05 |     2.55 |       12.76 |
| linked  | 3.76 |          8.60 |      8.62 |     2.79 |       13.31 |

Received-list p95 by total message count:

| Messages | Table | Graph | Graph + identity links |
| -------: | ----: | ----: | ---------------------: |
|       20 |  2.64 |  3.10 |                   2.79 |
|      200 |  2.67 |  3.16 |                   3.37 |
|     2000 |  2.91 |  5.05 |                   8.60 |

The linked graph's satisfied await probe was 2.73 ms p95 at 2,000 messages. Through the actual UI HTTP endpoint on the 26-message consumer fixture, received-list latency was 4.22 ms median / 7.03 ms p95, and sent-list latency was 3.17 / 3.42 ms (30 requests each). These HTTP results use the smaller fixture and must not be compared as if they shared the 2,000-message load.

The graph is measurably slower and larger than the dedicated table in this implementation, but the observed interactive reads remain under 10 ms p95 at the tested size. Lean output saves payload/context; it does not currently avoid graph hydration of body attributes. Lists also read outgoing edges per row. Identity-link startup reconciliation scans existing mail. Those are measured prototype tradeoffs, not optimized production query plans; performance on larger lakes, under concurrent writes and on cold starts remains unmeasured.

## Reproduction

From the graph worktree after installing dependencies:

```sh
bun scripts/mail-graph/smoke.ts
qlock exec --lock /tmp/agent-cpu.lock -w 60 -- bun scripts/mail-graph/benchmark.ts
bun scripts/mail-graph/live.ts
```

The table comparison expects the preserved reference worktree at the path above. Live runs require locally available/authenticated Codex and Pi with Luna; `BL_MAIL_PI_BIN` can select the Pi executable. Fixture state and child processes are cleaned in `finally`; experiment outputs stay under ignored `out/mail-graph/`. The initial failed live transcripts are retained under `out/mail-graph/live-history/`.

Build the UI worktree, then run the consumer from a durable terminal:

```sh
bun scripts/mail-graph/consumer.ts /Users/ct/dev/worktrees/botlake-ui-mail
```

It starts a loopback UI on port 18184, writes fixture metadata and API measurements into `out/mail-graph/consumer/`, and waits up to ten minutes. From the UI worktree:

```sh
node --experimental-transform-types scripts/mail-consumer-check.ts /Users/ct/dev/worktrees/botlake-mail-graph/out/mail-graph/consumer
```

Create `out/mail-graph/consumer/stop` in the graph worktree after inspection. The consumer stops its server and disposes the lake, then writes `cleanup.json`. No fixture or UI server is intended to remain running.

## Comparable live stress trials

On 2026-11-06, `scripts/mail-graph/stress.ts` repeated the original table prototype's three workloads and its separate deadline retry: 32 fresh Luna sessions in four disposable lakes, alternating Codex and native Pi. Scenario assignments, token checks, seven-minute task budgets, nine-minute runner caps and retrospective prompts were preserved. The runner changed lake setup and storage observation: graph Mail plus Batteries were selected, and the final snapshot used paginated public Mail reads instead of querying a mail table. The current graph primer and hooks were used, so this compares the implementations as agents experience them, not storage alone.

Task outcomes were captured before the agents were told about the retrospective. All 32 native sessions resumed under the same session IDs for feedback, with zero feedback process failures. No task process reached the runner's kill cap. No Mail hook failure or Mail-unavailable notice appeared in the captured diagnostics. Both disposable supervisors and all four graph lakes were removed.

| Workload | Earlier table run | Graph run |
| --- | --- | --- |
| 12 sequential ping-pong rounds | 24/24 exact messages acknowledged | 24/24 exact messages acknowledged; initiator artifact verified all 12 tokens |
| Seven senders × four items | All 28 items collected; six correct receipts sent, four verified by senders | All 28 items collected exactly; seven correct receipts sent, five verified by senders; two senders exited before arrival |
| Ten workers, natural waiting | Nine valid results; no HOLD phase | Ten valid results; ten HOLDs sent, nine acknowledged; no RELEASE or DONE |
| Ten workers, explicit deadline | Eight valid results; no HOLD phase | Full message sequence and all 50 actual messages acknowledged, but only 49/50 exact payload matches: one malformed RESULT incorrectly accepted |

The deadline trial is **not a full task-correctness pass**. Worker 3 omitted a character from its RESULT token, and the orchestrator claimed to verify it without detecting the mismatch. The captured send command already contained the typo; Mail stored and delivered that supplied body. Worker 3's local result file and later DONE token were correct, and it identified the mistake only in the retrospective. The orchestrator's final artifact incorrectly marked that result as verified. All ten worker result files were checked against their assigned numbers, squares and tokens; the sum was 385. Timestamps confirm the first RELEASE was sent after all ten HOLD acknowledgements. This verifies the transport and phase ordering, while exposing failed application-level validation.

The natural-waiting run still stalled because worker 7 ended after sending RESULT, before its HOLD arrived. Two fan-in senders similarly ended before their receipts. Eleven of the 32 agents executed the documented `await` pattern (119 calls observed in task tool commands), including two of those three early-exiting agents. Availability of a blocking query therefore does not make an agent stay for the entire assigned protocol. The explicit deadline improved this trial's coordination, but neither one trial nor a prompt establishes reliable lifecycle handling.

Recurring feedback: agents generally understood identity, urgency, lean reads and explicit acknowledgement; several still tried `mail help` instead of `help mail send`. Agents that used await reported it working, while others requested a wait operation that already exists. Some requested returning matching mail from await to avoid a separate inbox/read sequence. Several confused the appended hook notice with the preceding command's inbox snapshot. The collector's narrative also miscounted receipt states; durable results showed five acknowledged and two sent. Agent reports are useful usability evidence, not substitutes for stored-message and artifact checks. Live trials do not establish large-inbox paging behavior; the existing smoke and UI consumer cover paging.

These results support graph integration without showing that graph storage itself improved model reasoning. No product or primer changes were made between these trials. Group delivery and session resumption remain unimplemented; task-specific token verification belongs in the coordinating application or agent's deterministic checks.

Evidence:

- Table baseline: `/Users/ct/dev/worktrees/botlake-mail-poc/out/mail-poc/stress/2026-11-06T14-55-56.342Z/` and `2026-11-06T15-00-49.559Z/`.
- Graph natural trials: `out/mail-graph/stress/2026-11-06T18-27-48.810Z/`.
- Graph deadline trial: `out/mail-graph/stress/2026-11-06T18-36-30.870Z/`.
- Machine-readable phase comparison: `out/mail-graph/stress-comparison.json`.

Reproduce with `bun scripts/mail-graph/stress.ts all`, then `bun scripts/mail-graph/stress.ts orchestrator deadline`. The runner preserves failed outcomes rather than turning process exit zero or an acknowledgement into a successful task verdict. Run suites through the repository's `qlock` convention. Quality checks passed after adapting the runner.

## Remaining scope

Await covers a running agent waiting at a tool call; it cannot resume an exited session. Mail has no task-enforcement or agent-custody semantics. Delivery reports can be absent when a plugin is unavailable or the agent has not reached a boundary. Offset pages are live observations, so callers draining a changing inbox restart from zero. The UI is a read-only temporary consumer with explicit refresh, not mail-specific SSE updates. Parent edges permit later conversation queries; CC/group receipts and membership need a separate design decision.
