# @botlake/extension-work

Explicitly select Identity and Work. Imports are inert; `work()` selects the extension and `workStore(ctx)` exposes the same operations to other extensions.

```sh
bl prime work
bl work create "Delivery context" --kind group --description "Shared purpose and constraints"
bl work create "Investigate alternatives" --parent GROUP --description "Answer with supporting evidence"
bl work list --view available
bl work show TASK
bl work claim TASK
bl work update TASK --notes "Findings and supporting references"
bl work close TASK
```

Tasks are actionable leaves. Groups supply shared context and may contain groups/tasks, with one contextual parent per item. Group closure requires every contained task, including nested tasks, to be closed. Only tasks can be assigned. Groups can remain open after their tasks close; closure is explicit.

## Relationships

`node-model.ts` declares `workAttributes`, `workRelations` and stored-value schemas, available from the package's public exports. Task/group facts use native `work/*` attributes; criteria, assignments and recovery history are JSON arrays. Generic queries can select fields such as `q.attr("work/priority")`; mutations still require Work operations.

`parent-of` is contextual containment; `depends-on` is readiness; `references` is a non-contextual connection. Group prerequisites do not propagate to members.

```mermaid
flowchart LR
  ParentGroup["Group"] -- "parent-of" --> ChildGroup["Nested group"]
  ParentGroup -- "parent-of" --> TaskNode["Task"]
  TaskNode -- "depends-on" --> Prerequisite["Prerequisite task or group"]
  TaskNode -- references --> Related["Related task or group"]
```

`link FROM TO --relation depends-on` adds a direct prerequisite task or group. An open item is ready when all its direct prerequisites are closed. Containment and references do not create prerequisites; a group prerequisite does not silently become a prerequisite of its members. Closing work neither asserts success nor completes dependents. `references` retains useful non-contextual connections without adding inherited instructions.

Select one shared [References library](../references/README.md) explicitly in both lakes, configured with `workReferenceProjections`, and pass that binding to `work({ references })`. The selectors and imports are inert. For module-based configuration, export the binding from a selected `references.ts` module and import it into the selected Work module. Local-only Work needs no configuration.

`link FROM TO --to-workspace LAKE` imports TO from its owner and creates the local relationship. It returns the local endpoint ID and source provenance; neither descriptions nor histories are copied. `unlink` accepts the same endpoint/workspace pair without fetching owner state, or the returned local ID when the owner is unavailable. Local references remain after unlinking because other relationships may use them. A failed link after import reports the retained reference in error details.

The default `list` includes linked remote summaries, even when their originating local work is closed. Multiple links to one remote endpoint produce one row; unlinking its last Work relationship removes that row. State and source-kind filters apply to observations, and search matches their titles. Assignment, audience, origin and parent filters require locally owned facts; queue views (`ready`, `available`, `assigned`, `waiting`, `human`) stay local-only. `show REFERENCE_ID` returns its observed summary and owner; open the owning workspace for full detail or mutations.

A reference can be a prerequisite or non-contextual target, never an assignable task or contextual parent. Only source-verified `work/task` and `work/group` observations can satisfy prerequisites, and they must be current and closed. Stale, missing or replaced-source observations leave dependents waiting. Agent lifecycle states do not substitute for Work completion.

Work links record their accepted projection kinds on the dependency edge. Generic edge writes must preserve the exact Work constraint; use `work link` to supply it automatically. Losing the source classification blocks both Work queues and generic readiness used for targeted agent launch, even when the last observed node state is closed.

```sh
bl work link LOCAL_TASK REMOTE_TASK --to-workspace OTHER_LAKE --relation depends-on
bl work diagnose LOCAL_TASK
bl work unlink LOCAL_TASK LOCAL_REFERENCE_ID --relation depends-on
```

TypeScript consumers use `workLinks(ctx, references.get(ctx)).link({ from, to, toWorkspace, relation }, signal)` and `.unlink(...)`; local synchronous graph operations remain available through `workStore(ctx)`.

`diagnose ID` follows recorded prerequisite edges through live owners, with defaults of eight lakes, 1,000 nodes and 5,000 edges; `--max-lakes`, `--max-nodes` and `--max-edges` set explicit bounds. It returns one representative path per cyclic component, unavailable owners, reached limits and `complete`. Cycles can include closed historical work and do not establish current blockedness; an incomplete result does not establish the absence of cycles. `dependencies ID --limit 20 --offset 0` exposes bounded direct owner addresses with `nextOffset`; fetch that owner for current facts. Briefs and histories are omitted. These reads are observations, not a shared snapshot. Local cycle checks still cannot reject every cycle spanning multiple lakes, and a remote source can change after a dependent is claimed.

Defaults are AFK, planned, P2. P0 is immediate attention; P1–P4 decrease in urgency. `list --view human --assignee PERSON` shows ready HITL work routed to that person; filter `--origin planned|unplanned` for planned handoffs or interruptions. `available` excludes HITL, assigned and waiting work. `assigned` and `waiting` overlap. Assignment is responsibility, not proof of execution. Human assignments never expire automatically.

Criteria are optional. `criterion add TASK CONDITION` appends an immutable condition. `criterion resolve TASK CRITERION TEXT` records an assessment, including unmet or no longer required. Every added condition must be resolved before task closure; readiness is not a universal closure guard. Findings belong in notes; no global notes-presence rule applies.

`reopen ID --reason TEXT` is recovery, not new scope. It retains previous criterion resolutions and closure history. Reopen closed containing groups first. Use `criterion correct` to append a corrected assessment or `criterion reopen` to restore an open condition explicitly. Neither operation erases the original condition or prior assessments. Corrections may annotate closed work; reopening a condition requires an open task. Completed scope normally becomes new work.

Claim defaults to `BL_ACTOR`; competing owners must explicitly release before handoff. `release TASK --assignment-id TOKEN --reason TEXT` changes only the matching current assignment. Stale releases return `released: false`. Closure releases its assignment and preserves history. Optional [Work Agents](../work-agents/README.md) binds assignment tokens to managed agent liveness.

`show` includes the local brief, ancestor context, criteria, notes, prerequisites and references. `--history` expands assignment, criterion, closure and recovery history. Group members and lists default to 20 summaries, maximum 100; continue at `nextOffset`. Pages are not snapshots. `list --search TEXT` searches titles, descriptions and notes. With `--view all` it includes closed work unless `--state` narrows it; queue views remain open-only. Lists omit briefs and findings.

## Tree and graph

```sh
bl work tree                         # Group/task containment forest
bl work tree GROUP --state all -sd -ss
bl work graph TASK                   # Transitive prerequisites
bl work graph TASK --direction dependents
bl work graph --lean --format json   # All open dependency components
```

`tree [ID]` follows only `parent-of`; `graph [ID]` follows only `depends-on`. Without ID they include all matching work. Graph direction defaults to `prerequisites`; an explicit `--direction prerequisites|dependents` requires ID. Stored dependency edges always point from dependent to prerequisite, regardless of traversal.

Output defaults to a static text outline on a terminal and JSON otherwise. `--format text|json` overrides detection; global `bl --json` forces JSON. Both formats default to summaries. `--show-description` (`-sd`) and `--show-criteria` (`-ss`) expand local briefs and criterion assessments. `--lean` overrides expansions and keeps only `id`, `title`, `state` per node, preserving edges and topology metadata.

Remote endpoints retain reference identity and observation status even in lean graph output. Trees and local Work queues contain only locally owned tasks and groups.

`--state open|closed|all` defaults to `open`. An explicit root stays visible. Trees retain required nonmatching ancestors as context; graphs never bridge hidden nodes with invented edges. `omittedLinks` counts scoped links crossing the state filter. Readiness always considers actual prerequisites. JSON stores nodes once with typed edges, entry roots and component membership; text marks repeated branches as shown above.

[Workflow](../workflow/README.md) publishes this same task/group model. Only explicit authored workflow actions advance execution; ordinary Work closure never does. No agents launch automatically.

Verify the packaged CLI against disposable SQLite lakes with `bun scripts/work-smoke.ts` and `bun scripts/work-topology-smoke.ts`.
