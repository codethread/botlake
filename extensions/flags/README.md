# @botlake/extension-flags

Workspace-local described boolean flags shared by explicitly selected extensions. Overrides persist in the lake's SQLite database. No Agents dependency or implicit activation. Install the `@botlake/core` peer.

## Definitions and configuration

`flags({...})` creates an immutable, exportable collection of definitions. Each definition owns a stable name, description and default boolean. Importing definitions neither selects an extension nor shares runtime state between lakes.

```ts
import { configureFlags, flags } from "@botlake/extension-flags";

export const featureFlags = flags({
  example: {
    name: "feature/example",
    description: "Enable the example feature.",
    default: true,
  },
});

export default configureFlags([[featureFlags.example, false]]);
```

Select this local module instead of `"@botlake/extension-flags"`. Selecting the package directly supplies no configured defaults. `configureFlags([...])` requires `[definition, boolean]` pairs: every workspace default is explicit, even when it matches the definition's declared default. Changing an author's declared default cannot change a configured value. Definitions can come from other packages; duplicate configured names are errors. Definitions not included in configuration supply no flag state.

Configuration supplies defaults; database overrides take precedence across lake and host restarts. Configuration edits affect flags without overrides; resetting an override adopts the latest loaded default. Other workspaces are independent, even when they share imported definitions or a configured extension.

## Runtime overrides

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

CLI `set` requires `--description` for new or unset flags; on existing flags it replaces the description only when supplied. Reset removes database-only flags entirely. Bare `reset` and combining a name with `--all` are errors. The consuming extension defines what an unset flag means and when changes take effect.

## Consumers

Consumers declare `requires: ["flags"]`. Reads and mutations accept a `FlagDefinition` or a string name:

- `getFlag(ctx, definition)` returns the effective `Flag | undefined`; read `.value` for boolean conditions. Reading an unconfigured definition does not register it or apply its declared default.
- `inspectFlag(ctx, definition)` and `listFlags(ctx)` expose `FlagState` (`current`, `default`, `overridden`).
- `setFlag(ctx, definition, boolean)` persists an override, using the definition's description when no current flag exists. `setFlag(ctx, name, { value, description? })` also supports ad hoc flags and description updates.
- `unsetFlag(ctx, definition)` persists absence and reports whether a current flag was removed.
- `resetFlag(ctx, definition)` deletes one override and reports whether it existed; `resetFlags(ctx)` deletes all overrides and returns their count.

`FlagDefinition` has readonly `name`, `description` and `default` fields; `Flag` has readonly `description` and `value` fields. `flagsConfigSchema` and `flagsConfigJsonSchema()` describe the definition/boolean configuration list, including its serializable JSON form. Flags owns definitions, storage and commands; consumers own naming and policy.
