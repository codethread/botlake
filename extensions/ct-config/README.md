# ct-config

Personal lake configuration: agent roster and prompts, provider flags, reference projections, priming, Work and Work–Agents settings. Imports only construct extension descriptors; nothing activates until the lake explicitly selects it.

Install `ct-config` and its peers in the lake package. Keep each selected configuration module as a one-line wrapper:

```ts
export { agents as default } from "ct-config";
```

The configured exports are `agents`, `flags`, `references`, `priming`, `work` and `workAgents`. The `agents` and `work` exports retain their typed runtime bindings through the configuration helpers. Select their local wrappers in `botlake.extensions`, alongside Identity and any other desired extensions. Work requires Identity. Agents and Work share the same references descriptor. Work–Agents uses a 60-second check interval. Installing the package does not select any extension.

Consumers that need both implementations must import these exact configured objects rather than constructing same-name replacements:

```ts
import { workAutoBot } from "@botlake/extension-work-auto-bot";
import { agents, work } from "ct-config";

export default workAutoBot({ agents, work });
```

Use `configureWork({ probes })` instead of the configured `work` descriptor to add [trusted lake-local probes](../work/README.md#gates) while retaining the shared references binding.

Override or add lake-local aliases without repeating the shared wiring:

```ts
import { configureAgents, roster } from "ct-config";

export default configureAgents({
  "local-worker": {
    ...roster.aliases.astra,
    parent: "codex",
    model: "gpt-6-astra",
    effort: "xhigh",
    doc: "Lake-local Astra agent through native Codex.",
  },
});
```

Overrides merge by alias name without modifying the shared roster. Spreading an alias preserves its prompt; prompts do not inherit through `parent`. Each lake retains its own flags, database and runtime state.
