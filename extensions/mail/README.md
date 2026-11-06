# Mail

Direct mail represented by ordinary graph nodes, attributes and edges. Explicitly select `@botlake/extension-mail`, or a local module exporting `mail()` from that package. Installation and imports are inert. Core invocation identity supplies attribution; neither Identity nor Agents is required.

## Agent API

Run `bl --identity YOUR_ID prime mail` for the agent policy and `bl help mail send` for syntax. Pass the caller identity to every operation.

```sh
bl --identity neo mail send trinity 'Review' 'Please review the patch' --urgent
bl --identity trinity mail inbox
bl --identity trinity mail read MESSAGE_ID
bl --identity trinity mail ack MESSAGE_ID
bl --identity trinity mail reply MESSAGE_ID 'Reviewed; see the task notes'
bl --identity neo mail list --from neo --ack=false
bl --identity neo mail list --to trinity --status delivered --lean=false
```

`list` is lake-wide; `inbox` selects the caller's unacknowledged mail. Filters include `from`, `to`, exact `subject`, repeatable `status`, `ack`, `urgent`, `replies-to` and `about`. Pages return `{messages, nextOffset}` with 20 summaries by default (maximum 100); use `--offset NEXT_OFFSET` with unchanged filters. `--lean=false` includes bodies and outgoing graph links. Pages observe live data in creation-time/ID order. When acknowledging while draining an inbox, restart at offset zero because acknowledged entries leave that selection.

Reading does not mutate state. Acknowledgement means seen, not agreement, completion or a stopped process. `ack` and `delivered --id ID` are recipient-scoped and idempotent; attribution is not authentication. List and read are not privacy boundaries.

`reply ID BODY` addresses the original sender, preserves the subject, and links the new message to its parent through `mail/replies-to`. Correlate replies by parent ID, not a special subject. Branches are possible, with one parent per reply. There is no thread entity, CC, membership or group-delivery policy.

## Graph model

One node stores one message: title is the subject, with `mail/message`, `mail/from`, `mail/to`, `mail/body`, `mail/urgent` and `mail/delivery` attributes. Delivery is a discriminated union:

- `sent`: stored; no reported notification handoff.
- `delivered`: recipient plugin reported a notification handoff, with `deliveredAt`.
- `acknowledged`: recipient explicitly reported seeing the message, with `acknowledgedAt`; `deliveredAt` can remain null when read directly.

A late delivery report preserves acknowledgement. Message content and reply relationships are changed through the Mail API. There are no mail-specific SQL tables or mirrored records.

`send --about NODE_ID` adds a `mail/about` context edge to an existing task, run or other node. It does not prove that run sent or received the message. Optional [Mail–Identity composition](../mail-identity/README.md) adds `mail/sent-by` and `mail/sent-to` links to registered identities. Routing identity strings remain usable without registration.

## Await and queries

With Batteries explicitly selected, existing `await` can observe mail:

```sh
bl --identity trinity await --query mail-pending --params '{"recipient":"trinity"}' --min-count 1 --timeout-secs 30
```

Inspect `reason`: `satisfied` permits reading the matching inbox; timeout means the condition was not met within the window. Continue waiting if required by the assignment. Acknowledge seen messages before waiting for more. Await neither reads nor acknowledges mail and cannot resume a session that has exited. For managed runs that must end their turn while waiting, optionally select [Mail–Agents](../mail-agents/README.md) and arm one continuation before exiting.

| Named query                                       | Parameters  |
| ------------------------------------------------- | ----------- |
| `mail-received`, `mail-sent`                      | `identity`  |
| `mail-pending`, `mail-urgent-pending`             | `recipient` |
| `mail-unacknowledged-from`                        | `sender`    |
| `mail-acknowledged`, `mail-replies`, `mail-about` | `id`        |

Queries return graph nodes, whose attributes include bodies; use lean Mail operations for concise agent output. `mail-replies` selects direct children, not recursive conversation history.

[Harness adapters](../../plugins/mail/README.md) supply summary notifications. [Measurements and reproduction](../../docs/engdocs/mail-graph.md) cover disposable databases, cross-harness waiting and the UI consumer.
