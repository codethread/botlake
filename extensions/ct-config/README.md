# ct-config

Personal lake configuration: agent roster and prompts, provider flags, reference projections, priming, Work and Work–Agents settings. Imports only construct extension descriptors; nothing activates until the lake explicitly selects it.

`ct-config` is a private source package. It is packed locally and never published. From the repository root, create and verify the canonical archive:

```sh
rm -rf dist/private && mkdir -p dist/private
(cd extensions/ct-config && bun pm pack --destination ../../dist/private --ignore-scripts)
bun scripts/verify-private-config.ts
```

Freeze `dist/private/ct-config-0.1.1.tgz` in the canonical checkout. Add that tarball as the lake's `ct-config` file dependency and install its public peers from npm. Bun rewrites the source manifest's `workspace:^` peer protocols to ordinary compatible version ranges in the archive; consumers therefore resolve core and extensions from their own `node_modules`, not this repository.

Keep the configuration source only here. Do not create package-generation tasks or copy configuration into consumers. Keep each selected consumer module as a one-line import wrapper:

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
