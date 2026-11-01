# @botlake/extension-references

A TypeScript library for following source-owned node summaries across independent lakes. Configure one binding, select it explicitly, and inject that same binding into domain extensions. Imports are inert; the library installs one synchronization resource per lake and a JSON-only peer protocol.

```ts
import { agents, agentReferenceProjections } from "@botlake/extension-agents";
import { references } from "@botlake/extension-references";
import { work, workReferenceProjections } from "@botlake/extension-work";

const shared = references({
  projections: [...workReferenceProjections, ...agentReferenceProjections],
});

// Select Identity and Flags too, as required by Work and Agents.
const selected = [shared, work({ references: shared }), agents({ references: shared })];
```

For module-based configuration, export `shared` as the default from a selected `references.ts`. Selected Work and Agents configuration modules import that binding and pass it to their factories. Select the library in both the source and consuming lakes. Generic consumers need only Core; no domain extension is activated by the library.

Domain commands own the workflow:

```sh
bl --workspace ui work link UI_TASK API_TASK --to-workspace api --relation depends-on
bl --workspace ui work unlink UI_TASK API_TASK --to-workspace api --relation depends-on
bl --workspace ui agent follow RUN_ID --from-workspace api
```

`--workspace` before the operation selects where the command runs. `--to-workspace` qualifies the linked endpoint; `--from-workspace` identifies the owner of an observed run. Agent execution and custody remain at the owner. Work links return the local endpoint ID and provenance; the local ID can also be used to unlink while the owner is unavailable.

Obtain the lake-scoped instance during activation. Call `follow`, `lookup` and `refresh` from registered operation handlers after resource startup; they reject before startup and after shutdown:

```ts
import { defineOp, jsonSchema } from "@botlake/core";
import { z } from "zod";

// Inside the consuming extension's activate(ctx):
const refs = shared.get(ctx);
ctx.register(
  defineOp({
    name: "contract",
    input: z.object({ workspace: z.string(), nodeId: z.string() }),
    output: jsonSchema,
    async handler(source, _ctx, request) {
      const node = await refs.follow(source, request.signal, {
        kinds: ["work/task", "work/group"],
      });
      return { id: node.id, reference: node.reference };
    },
  }),
);
```

`follow` checks requested projection kinds before importing. `lookup(address, signal)` resolves the workspace route and finds an existing local handle without reading the source; ambiguous retained owners require a local reference ID. `refresh(id, signal)` updates an exact retained handle. `list({ limit, offset, lakeId })` and `status(...)` include `total` and `nextOffset`; null means exhausted. Lists exclude source attributes and perform no remote calls. `forget(id)` removes only the local import and incident edges. An in-flight refresh cannot recreate a forgotten handle. Removing the final reference retires its subscription.

Source classifiers use only owned node fields and attributes. Edge predicates, query parameters and overlapping classifications fail explicitly. An unmatched source kind is null; Work prerequisites accept only `work/task` or `work/group`, and Agent follows accept only `agent/run`.

Core provenance contains the owner lake UUID, workspace route, source node ID/revision, classification, observation time and current/stale/missing status. Source attributes, descriptions, prompts, histories and results remain remote. Generic updates, supersession and deletion reject references; `forget` removes the local import. Local notes and relationships remain local.

Streams subscribe before snapshots, coalesce selected invalidations, and refetch on reconnect. Disconnection and restart make observations stale. Confirmed source deletion retains a missing reference. Source reads are cancellable and bounded; `reconnectMs` defaults to 500 and `requestTimeoutMs` to 5000.

A new database at the same workspace route cannot retarget an existing reference. Following the same source at a moved route preserves its local ID and resumes synchronization. Each UUID identifies one authoritative database; independently modifying database copies is unsupported.

Readiness uses observed facts, not a shared transaction. A source can change after a dependent is claimed. Cross-lake cycles cannot be rejected atomically: `work diagnose TASK` reports representative cycle paths, unavailable owners and explicit completeness/limits. This library does not install a dispatcher.
