# @botlake/extension-identity

Native session identity, activity observations and attribution. Requires the `@botlake/core` peer package; no prerequisite extensions.

Select `"@botlake/extension-identity"` in workspace `extensions`, or import `identity()` for programmatic activation. Imports are inert. `nativeStartup` upserts deterministic identities from provider/native-session keys; `observeIdentity` records supported lifecycle metadata. `recordParticipation` links managed invocations; `resolveIdentity`, `attribute` and `attribution` resolve provenance. Native parent evidence creates `spawned` edges.

Native client adapters are the separate `@botlake/identity` package. Observation never grants process ownership or implies task completion.
