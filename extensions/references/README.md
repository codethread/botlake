# @botlake/extension-references

Explicitly select References in both lakes to follow source-owned node summaries. Imports are inert; no domain extension is activated by selecting References. Generic references need only Core. For Work prerequisites, explicitly select Identity and Work, and select a local References configuration:

```ts
import { references } from "@botlake/extension-references";
import { workReferenceProjections } from "@botlake/extension-work";

export default references({ projections: workReferenceProjections });
```

Source projection selectors classify records using their own node fields/attributes. They cannot use edges or query parameters. Overlapping classifications fail explicitly. Without a matching projection, the observed kind is null; such nodes remain useful references but cannot satisfy Work prerequisites.

```sh
bl --workspace api work create "Publish order contract"
bl --workspace ui reference add api API_TASK
bl --workspace ui work create "Implement order form" --prerequisite LOCAL_REFERENCE
bl --workspace ui work show UI_TASK
bl --workspace ui work diagnose UI_TASK
```

`add WORKSPACE NODE` returns the local reference ID and observed facts. Use that ID with normal edges or Work links. Work accepts source-verified `work/task` and `work/group` prerequisites only; current plus closed is required. Agents must target the authoritative task in its owning lake, with an explicit working directory. Importing a run does not create local execution or custody.

Core metadata carries the source lake UUID, workspace route, source node ID/revision, classification, observation time and current/stale/missing state. Source attributes, descriptions, prompts, histories and results remain remote. `node show` and topology summaries expose provenance. Generic updates, supersession and burn reject references; use `reference forget` to remove a local import. Local notes and relationships remain local.

```sh
bl reference list --limit 20
bl reference list --lake-id LAKE_UUID --offset NEXT_OFFSET
bl reference status
bl reference refresh LOCAL_REFERENCE
bl reference forget LOCAL_REFERENCE
bl --workspace api reference source
```

List/status results include total and nextOffset; null means exhausted. Lists filter before reading records and perform no remote calls. Refresh waits for an observation covered by a live subscription. Forget deletes only the local reference and incident edges. An in-flight background refresh cannot recreate it. Removing the final reference retires its source subscription.

Streams subscribe before snapshots, coalesce selected invalidations, and refetch on reconnect. Lost streams mark observations stale; restarting Core also invalidates persisted current observations, even when synchronization is no longer selected. Confirmed source deletion retains a missing reference. Source calls are cancellable and bounded; configuration supports `reconnectMs` (default 500) and `requestTimeoutMs` (default 5000).

A workspace route resolving to a new database cannot retarget an existing reference. A moved database retains its UUID: call add with its new route and original node ID to preserve local reference IDs and resume following that owner. Each UUID identifies one authoritative database; independently modifying database copies is unsupported.

Readiness uses observed facts, not a transaction shared with another lake. A source can change after a dependent is claimed. Cross-lake cycles cannot be rejected atomically by local edge checks: `work diagnose TASK` returns representative cycle paths, unavailable owners and explicit completeness/limits. This does not install a dispatcher or automatically launch agents.
