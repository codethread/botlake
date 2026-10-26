# @millstrand/spool-flags

Workspace-local boolean flags shared by explicitly selected spools. No Harnesses dependency, persistence or implicit activation. Install the `@millstrand/core` peer.

Select `"@millstrand/spool-flags"` for an empty flag set, or select a local module instead:

```ts
import { flags } from "@millstrand/spool-flags";

export default flags({ "feature/example": true });
```

```sh
strand flag list
strand flag get feature/example
strand flag set feature/example false
strand flag unset feature/example
```

Changes last until Weaver restart, which reapplies the module's defaults. Unsetting removes the value for the current runtime, including a configured default. CLI `get` returns `null` when unset; the library returns `undefined`. Other workspaces are independent. The consuming spool defines what an unset flag means and when changes take effect.

Consumers declare `requires: ["flags"]` and use `getFlag(ctx, name)`, `listFlags(ctx)`, `setFlag(ctx, name, boolean)` or `unsetFlag(ctx, name)` from the public package. `flagsConfigSchema` and `flagsConfigJsonSchema()` describe the defaults map. Flags owns storage and commands; consumers own naming and policy.
