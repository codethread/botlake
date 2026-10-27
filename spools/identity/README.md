# @botlake/spool-identity

Native session identity, reservations and attribution. Requires the `@botlake/core` peer package; no prerequisite spools.

Select `"@botlake/spool-identity"` in workspace `spools`, or import `identity()` for programmatic activation. The default export is an inert Identity spool. Public helpers include `nativeStartup`, `reserveIdentity`, `resolveIdentity`, `attribute` and `attribution`.

Native client adapters are a different package: `@botlake/identity`. Installing adapters does not activate this spool or grant process ownership.
