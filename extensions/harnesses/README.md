# @botlake/extension-harnesses

Tracked headless agent runs, providers, documented aliases, assignment, resume/retry and custody reconciliation. Install the `@botlake/core`, `@botlake/extension-identity` and `@botlake/extension-flags` peers; explicitly select Identity and Flags alongside this extension. Botlake supplies process custody.

Select `"@botlake/extension-harnesses"` for Codex, Pi and Claude defaults. For configuration, select a local module instead:

```ts
import { harnesses } from "@botlake/extension-harnesses";

export default harnesses({
  aliases: {
    sol: {
      doc: "Complex implementation and debugging.",
      parent: "pi",
      model: "openai-codex/gpt-5.6-sol",
      effort: "low",
      when: "model/openai",
    },
    opus: {
      doc: "Greenfield features, API design and critical review.",
      parent: "claude",
      model: "opus",
      when: "model/anthropic",
    },
    reviewer: ["sol", "opus"],
  },
});
```

In a separate selected [Flags module](../flags/README.md), configure described defaults:

```ts
import { flags } from "@botlake/extension-flags";

export default flags({
  "model/openai": { description: "Enable OpenAI model seats.", value: true },
  "model/anthropic": { description: "Enable Anthropic model seats.", value: true },
});
```

Database flag overrides survive restarts; `bl flag reset NAME` restores its configured default. Unset custom flags are false in alias conditions. Every registered provider is enabled unless its `harness/NAME` flag's value is explicitly false.

## Catalog and routing

- `parent` names a provider or alias. Nearest child model/effort/extraArgs settings replace their parent's; `systemPrompts` accumulate parent-first. A concrete `provider` descriptor also works.
- An alias can be a descriptor, another seat's name, or a nonempty ordered array of either. The first candidate whose condition and parent chain are available wins. Missing parents, cycles and disabled flags produce visible unavailability reasons. Fallback selects before launch; it is not a retry after execution failure or an installed-model probe.
- `when` accepts a flag name or nested expressions such as `["and", "model/openai", ["not", "maintenance"]]`; `or` is also supported. Provider flags apply through every alias chain.
- `doc` explains when to use a seat. Names inherit their selected parent's docs; use full candidate descriptors to document role-specific choices, e.g. `reviewer: [{ doc: "Prefer Sol for review.", parent: "sol" }, { doc: "Fallback review.", parent: "opus" }]`.
- Accepted runs freeze their resolved settings. Flag changes affect new starts, not queued/running runs, retries or native resumes. Exact request replay returns its original accepted run even if the alias is now disabled.

```sh
bl agent catalog                  # Docs, effective settings and availability, including disabled seats.
bl agent catalog reviewer         # Full candidates, settings and unavailability reasons.
bl flag set model/openai false    # reviewer now selects opus, if Claude/Anthropic are enabled.
bl agent start --seat reviewer --cwd "$PWD" --prompt "Review the code; do not edit files."
bl agent show RUN_ID
bl flag set harness/claude false  # Keep Claude registered, but unavailable for new selection.
```

`agent list` lists runs. All managed launches are headless, regardless of the seat's name.

`harnessConfigSchema` and `harnessConfigJsonSchema()` describe aliases. Flags configuration belongs to Flags, not this schema. Imports are inert; configuration edits require lake restart.

Caller-sensitive allow/deny visibility, live alias registration/unregistration, arbitrary overlay attributes, per-run settings overrides and interactive launch are not implemented.

## Provider strategies

`harnesses()` accepts custom implementations of Codex, Pi and Claude through `providers`. Pass `providers: [provider("codex"), provider("pi")]` to select only those two built-ins.

Each `Provider` supplies `name`, catalog `doc`, `prepare(run)` and `finish(run, exitCode, stdout, stderr)`. `ProviderRun` carries portable settings (`model`, `effort`, `extraArgs`, ordered `systemPrompts`) plus prompt and cwd. Fresh launches have no session ID; resumes carry a previously observed native ID. The strategy maps these to native flags in a `LaunchPlan` and parses native output into an `Outcome`; the runtime owns custody, persistence and native identity binding.

`Seat`, `Alias`, `Condition`, `HarnessConfig`, `HarnessOptions`, `StartRun`, `Harnesses` and the provider contracts are public exports.

## Native integration

[Native adapters](../../plugins/identity/README.md) are separately delivered as `@botlake/identity`. Harnesses never allocates fresh native session IDs or reserves identities. Callbacks bind provider/session evidence to the current managed invocation; direct sessions remain external and cannot be stopped through Botlake.

`harness/integration` distinguishes `unobserved`, `native` and `output`. Missing plugins do not fail an otherwise successful run: native output can confirm identity, but does not fabricate activity or model metadata. Resume requires confirmed session evidence and settled custody. Activity snapshots are observations, not process state; successful processes do not automatically close their tasks.
