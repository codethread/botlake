# @botlake/extension-flags

Workspace-local described boolean flags shared by explicitly selected extensions. Overrides persist in the lake's SQLite database. No Agents dependency or implicit activation. Install the `@botlake/core` peer.

Select `"@botlake/extension-flags"` for no configured defaults, or select a local module instead:

```ts
import { flags } from "@botlake/extension-flags";

export default flags({
  "feature/example": { description: "Enable the example feature.", value: true },
});
```

Every definition requires a nonempty description and a boolean value. Configuration supplies defaults; database overrides take precedence across lake and host restarts. Configuration edits affect flags without overrides; resetting an override adopts the latest loaded default. Other workspaces are independent.

```sh
bl flag list
bl flag get feature/example
bl flag set feature/example false # Persists; preserves its description.
bl flag set feature/other true --description "Enable the other feature."
bl flag unset feature/example     # Persists absence, even with a configured default.
bl flag reset feature/example     # Delete its override; restore the configured default.
bl flag reset --all               # Delete every override and persistent unset.
```

`list` returns a name-keyed map of `{ current, default, overridden }`; `get` adds `name`. `current` and `default` are `{ description, value }` records or `null` when absent. `overridden` indicates a database entry, even when it equals the default or persistently unsets the flag. Lists include persistent unsets so they remain discoverable and resettable.

`set` requires `--description` for new or unset flags; on existing flags it replaces the description only when supplied. Reset removes database-only flags entirely. Bare `reset` and combining a name with `--all` are errors. The consuming extension defines what an unset flag means and when changes take effect.

Consumers declare `requires: ["flags"]` and use the public API:

- `getFlag(ctx, name)` returns the effective `Flag | undefined`; read `.value` for boolean conditions.
- `inspectFlag(ctx, name)` and `listFlags(ctx)` expose `FlagState` (`current`, `default`, `overridden`).
- `setFlag(ctx, name, { value, description? })` returns the persisted flag; `unsetFlag(ctx, name)` persists absence and reports whether a current flag was removed.
- `resetFlag(ctx, name)` deletes one override and reports whether it existed; `resetFlags(ctx)` deletes all overrides and returns their count.

`Flag` has readonly `description` and `value` fields. `flagsConfigSchema` and `flagsConfigJsonSchema()` describe configured defaults. Flags owns storage and commands; consumers own naming and policy.
