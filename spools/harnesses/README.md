# @millstrand/spool-harnesses

Tracked agent runs, providers, aliases, assignment/review, resume/retry and custody reconciliation. Install the `@millstrand/core` and `@millstrand/spool-identity` peers; explicitly select Identity alongside this spool. Mill supplies process custody.

Select `"@millstrand/spool-harnesses"` for defaults. For configuration, select a local module instead:

```ts
import { harnesses, harnessConfigSchema } from "@millstrand/spool-harnesses";

import config from "./harnesses.json";

export default harnesses(harnessConfigSchema.parse(config));
```

```json
{ "aliases": { "worker": { "provider": "codex" } }, "reviewers": {} }
```

`harnesses()` includes Codex, Pi, Claude and Cursor, and also accepts custom providers. `provider`, provider types, `Harnesses`, `harnessConfigSchema` and `harnessConfigJsonSchema()` are public exports. Core knows nothing about this configuration.

Cursor bundles a session-start plugin that binds the run’s native identity and injects policy context on new and resumed sessions. Its model selector combines `model`, optional `effort`, and optional `fast`. The hook uses Cursor’s documented [sessionStart contract](https://cursor.com/docs/hooks).

Codex/Claude/Pi native adapters are separately delivered as `@millstrand/identity`. Nothing installs into user profiles automatically. Native sessions do not grant custody; successful processes do not automatically close their tasks.
