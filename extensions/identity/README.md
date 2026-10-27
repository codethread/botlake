# @botlake/extension-identity

Native session identity, reservations and attribution. Requires the `@botlake/core` peer package; no prerequisite extensions.

Select `"@botlake/extension-identity"` in workspace `extensions`, or import `identity()` for programmatic activation. The default export is an inert Identity extension. Public helpers include `nativeStartup`, `reserveIdentity`, `resolveIdentity`, `attribute` and `attribution`.

Native client adapters are a different package: `@botlake/identity`. Installing adapters does not activate this extension or grant process ownership.
