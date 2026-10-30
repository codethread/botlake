# Workflow spike

Core is unchanged. Explicitly selected extensions compose:

- **Workflow:** user-authored XState modules, state-node work visits, Identity claims and atomic completion/publication.
- **Kanban:** independent work ownership and opt-in `children` progression.
- **Workflow-Kanban:** optional root containment, without its own progression or blocking mechanism.

```text
Kanban card (optional)
  -> workflow root
       -> titled grouping state visit
            -> worker state visit
                 -> ordinary graph subwork (optional)
```

The [Workflow contract](../extensions/workflow/README.md) retains Busybee's definition/frontier semantics while replacing external tracker coordination with one graph transaction. Complete snapshots, frozen task metadata/context and fresh re-entry visits preserve nested-machine and parallel behaviour. The public lifecycle is catalogue, start, focused show, claim and atomic complete. Run summaries include compact, unpaginated decisions; task detail contains instructions, schemas, assignments and original outcomes.

Workflow and Kanban independently implement the [work blockage protocol](work-blockages.md). No shared service, extension or Core domain logic is introduced. Operational holds are separate from graph readiness and XState state. The optional containment adapter owns neither holds nor lane projection.

## Verify

```sh
bun install
bun scripts/workflow-smoke.ts
```

The smoke packs packages, builds Go CLIs, uses authored examples in private SQLite lakes, checks real commands/files/restarts and removes disposable data. Authenticated cold-agent trials receive one task brief and normal discovery, in fresh disposable Git workspaces. Run Sol, inspect its transcript and independent verdict, then Luna:

```sh
bun scripts/workflow-agent-trial.ts sol /tmp/workflow-sol-evidence
bun scripts/workflow-agent-trial.ts luna /tmp/workflow-luna-evidence
```

Trials retain transcripts, graph state, artifacts and verification evidence. Credential copies and private lakes are removed. Fix genuine discovery failures and rerun fresh rather than coaching the agent.

Exact definition identity is required on restoration; there is no migration, cancellation or durable external-effect execution. XState 5.33.3 uses a two-line declaration patch for strict optional properties. Runtime code and TypeScript strictness are unchanged. Root Bun patches do not automatically propagate to downstream consumers.
