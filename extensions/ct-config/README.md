# @botlake/extension-ct-config

Shared lake configuration: agent roster and prompts, provider flags, reference projections, priming, Work and Work–Agents settings. Imports construct extension descriptors; nothing activates until the lake explicitly selects it.

Install this package and its public Botlake prerequisites from npm:

```sh
bun add --cwd .botlake @botlake/extension-ct-config@latest
```

Keep each selected lake module as an import of the configured descriptor:

```ts
export { agents as default } from "@botlake/extension-ct-config";
```

The configured exports are `agents`, `flags`, `references`, `priming`, `work` and `workAgents`. The `agents` and `work` exports retain their typed runtime bindings through the configuration helpers. Select their local wrappers in `botlake.extensions`, alongside Identity and any other desired extensions. Work requires Identity. Agents and Work share the same references descriptor. Work–Agents uses a 60-second check interval. Installing the package does not select any extension.

Consumers that need both implementations must import these exact configured objects rather than constructing same-name replacements:

```ts
import { agents, work } from "@botlake/extension-ct-config";
import { workAutoBot } from "@botlake/extension-work-auto-bot";

export default workAutoBot({ agents, work });
```

Use `configureWork({ probes })` instead of the configured `work` descriptor to add [trusted lake-local probes](../work/README.md#gates) while retaining the shared references binding.

Override or add lake-local aliases without repeating the shared wiring:

```ts
import { configureAgents, roster } from "@botlake/extension-ct-config";

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
