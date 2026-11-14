# Mail notifications

Private harness entry points for the packaged Codex and Pi adapters owned by [`@botlake/extension-ct-config`](../../extensions/ct-config/README.md). They derive the same native-session identity as the identity plugin without requiring that plugin or either server-side Identity/Agents extension.

The Codex manifest registers `SessionStart` and `PostToolUse`. Pi adds startup guidance and appends text through `tool_result`. Startup supplies the mail identity and a pointer to `bl prime mail`; that operation owns the read/acknowledge/reply policy. Notifications contain only a count, up to three sender/subject summaries (urgent first), urgency markers, and the inbox command. They do not repeat the primer or include message bodies.

Adapters report delivery, but never send mail, acknowledge it, steer, wake or cancel an agent. Mail sent after the last supported tool boundary waits until another opportunity.

Configure the child process environment explicitly:

- `BL_WORKSPACE`: lake path used by the CLI and hook.
- `BL_BIN`: optional CLI executable; defaults to `bl`.
- `BL_MAIL_TRACE`: optional JSONL observation file for experiments; its parent must exist.

Pi loads `pi.ts` through an explicit `-e` flag. Codex loads the included plugin manifest; the live runner uses equivalent invocation-local hook declarations. These private files delegate to the public package rather than maintaining another adapter implementation. The repository-local plugin marketplace lists `botlake-mail` as available, not enabled. Neither installation nor this repository activates mail globally.

Each poll fetches up to 100 summaries with status `sent`, so urgency beyond that batch waits for another boundary. The plugin reports delivery for the announced batch, including messages covered by its count but omitted from the three displayed subjects. Codex records the receipt after writing its response; Pi records it while preparing to return the augmented tool result. Both are plugin-reported handoff evidence, not a host-confirmed read receipt. A failed report leaves messages eligible for retry.

Notification suppression uses the graph's delivery state; there are no cursor files. Pi serializes polls in process. Concurrent Codex hooks can announce the same messages before either records delivery. There is no exactly-once delivery guarantee, and a recorded handoff does not prove the model saw it. All deliverable unacknowledged messages remain available through the inbox, including previously delivered mail. Optional trace failures write a diagnostic without discarding mail.

Codex's `additionalContext` is delivered as developer context; Pi appends ordinary tool content. Peer metadata is labelled, but labels do not erase this transport difference. Message bodies remain behind explicit CLI retrieval. A stopped or unavailable lake produces a visible warning and does not block the original tool.

Reproduction commands and observed limitations are in the [graph experiment report](../../docs/engdocs/mail-graph.md).
