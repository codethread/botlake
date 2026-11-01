# @botlake/extension-identity

Native session identity, activity observations and attribution. Requires the `@botlake/core` peer package; no prerequisite extensions.

Select `"@botlake/extension-identity"` in workspace `extensions`, or import `identity()` for programmatic activation. Imports are inert. `nativeStartup` upserts deterministic identities from provider/native-session keys; `observeIdentity` records supported lifecycle metadata. `recordParticipation` links managed invocations or external sessions; `resolveIdentity`, `attribute` and `attribution` resolve provenance. Native parent evidence creates `spawned` edges.

## CLI

```sh
bl identity startup --provider pi --native-session-id SESSION_ID
bl identity show IDENTITY
bl identity list
```

`startup` requires a provider (`codex`, `pi` or `claude`) and native session ID. It returns the deterministic identity, graph node ID, whether it was created or recovered, and the adapter instruction. Optional `--parent-native-session-id` records native parentage. Startup metadata defaults from `BL_AGENT_SEAT`, `BL_MODEL` and `BL_EFFORT`; `--agent-seat`, `--model` and `--thinking-level` override them. Defaults use only the caller's `ctx.env.bl`, never the lake environment. Explicit JSON `null` clears metadata; the CLI accepts string overrides. Programmatic `nativeStartup`/`observeIdentity` use only their supplied input.

`show [IDENTITY]` defaults to the caller's `BL_ACTOR` and returns the full identity record, including the last reported activity and metadata. `list` returns `{ identities, total, nextOffset }` summaries (default 20, maximum 100); continue with `--offset nextOffset` until `null`. Pages are ordered by creation time then ID, not a shared snapshot. Each summary contains identity, node ID, provider, last activity and observation time. Use `show IDENTITY` to expand native session paths and metadata. Activity is an observation, not a liveness guarantee.

## Relationships

`node-model.ts` declares `identityAttributes` and `identityRelations`, available from the package's public exports.

`spawned` links a parent native session to a child session; `performed` links an identity to a managed invocation or external session run. `attributed`, `reported` and `claimed` link an identity to records whose provenance it supplies. Participation does not confer process custody; activity is the last reported event, never process liveness.

```mermaid
classDiagram
  class Identity
  class Run
  class GraphNode
  Identity --> Identity : spawned
  Identity --> Run : performed
  Identity --> GraphNode : attribution
```

Native client adapters are the separate `@botlake/identity` package. Observation never grants process ownership or implies task completion.
