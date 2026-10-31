# Work coordination workshop

Historical workshop notes. The [reviewed PRD](prd/work-coordination.md) consolidates the latest decisions and supersedes earlier exploratory proposals in these notes.

Design discussion, 30 October 2026. Kanban and Workflow may be rewritten or replaced. The goal is to find the smallest useful model for coordinating work across people and agents, with views that expose the right information.

## Current decisions

- Drop the mandatory epic, feature, and task hierarchy. Reintroduce distinctions only when they have a specific purpose. Use **task** below for an individual work item, independent of the former hierarchy.
- Core **nodes** remain generic entities available to many extensions. The task is a domain concept; this discussion does not redefine every node as work.
- Use one task model across questions, investigations, spikes, implementation, bug fixes, and organizational work. Separate investigation and delivery types are not needed for the current cases.
- A task has a title and description, with optional acceptance criteria and optional notes. Description says what the task is about; acceptance criteria say how completion is judged; notes hold conclusions, findings, results, and supporting references. Implementation details can remain open.
- Acceptance criteria are optional, including at closure. **Every criterion that has been added must be resolved before the task closes.** The previous requirement for at least one criterion is withdrawn.
- Acceptance criteria use the minimal lifecycle **open / resolved**. Resolution explicitly records what happened, such as met, unmet with a reason, or no longer required with a reason. The resolution vocabulary and structure are still open.
- Preserve criteria as an append-only list: retain their original conditions rather than deleting or rewriting them to bypass closure. A condition that is no longer required receives an explicit resolution; a replacement condition is appended. Exact correction and resolution-history mechanics remain open.
- The authoring agent, another agent, or a person may assess criteria. Independent verification and restrictions on who may resolve them are not part of the starting model.
- An ergonomic task API should hide whether criteria are embedded data or separate graph nodes. Their storage representation remains undecided.
- New scope becomes new tasks. A finished spike retains its findings and completion record; making that spike production-ready is follow-on work. How those tasks are grouped and linked remains open.
- Each task or group has at most one contextual parent; roots have none. Multiple contextual group memberships are discarded. Other references may be numerous, but do not add inherited instructions.
- Only groups can be contextual parents. Groups may contain groups or tasks; tasks are actionable leaves and contain neither groups nor other tasks. Groups cannot be claimed or assigned as executable work. Dependencies between tasks express prerequisites independently of the grouping hierarchy.
- Closed means no further action is expected on that task. Record who closed it and when automatically. A separate free-text close reason is unnecessary; notes can explain why work ended.

Criteria need enough substance to evaluate completion. A resolved criterion records a disposition; it does not necessarily assert that the requirement was satisfied. Retaining conditions and resolutions makes changes visible, but does not itself enforce the quality or authority of an assessment.

## Task lifecycle and outcomes

The task lifecycle is binary, with the working names **active / closed** (also discussed as active / done). Closed means no further action is expected on the task. Closure records its actor and time automatically. Open / resolved is the criterion lifecycle, not an additional task status enumeration.

All criteria being resolved means each has been accounted for. It does not necessarily mean the intended result was achieved. Notes and criterion resolutions supply that context. A structured overall outcome would need a concrete filtering or reporting use case before being added. A task without criteria may close when its requested outcome has been addressed; an artificial criterion is not required merely to satisfy the schema.

Acceptance criteria describe conditions; subtasks describe work. A criterion that requires substantial independently actionable work may motivate a separate work item, but the two concepts need not be identical.

## Assignment and agent availability

Tasks need a current assignee field. Plugins will determine agent liveness and clear an assignment after a defined heartbeat expiry or when the agent is known to be gone, making the work available to another agent. Preserve historical assignments. The user has deferred the storage choice, including fields versus separate records and edges; assume current-assignee detection and historical recording can be supplied programmatically.

The concrete agent-facing state model is still being worked through. Outstanding versus closed, dependency readiness, assignment, current activity, and inability to proceed are distinct facts. Assignment release alone must not discard an unresolved impediment or turn an abandoned run into task completion.

### Persistent impediments under discussion

Prerequisite tasks are a candidate for agent-resolvable impediments: a daemon could assign work that removes a prerequisite, after which the original task becomes ready. Human-only actions also need to be routed and surfaced without repeatedly assigning the original task to agents that cannot proceed.

The user proposes a blocked marker with a reason, represented as task data or a linked record. It must survive the worker unassigning itself or its assignment expiring, and suppress reassignment until the impediment is resolved. The exact representation, routing, and relationship to dependency readiness remain open. A durable request should explain what action would remove the block, rather than only recording that an agent stopped.

The historical example is a test-duration policy requiring approval before merging. Agents repeatedly interpreted that prose as a reason to stop implementation or refuse to complete a review. The intended boundary was to prepare and review a concrete pull request, then obtain approval at merge. A merge constraint should not automatically prevent earlier permitted work; block the relevant action or task only when that boundary is reached.

## Human dashboard views

The dashboard answers three questions: what needs my attention, what is happening, and what is available to pick up next. The following facts support those views; they are not a prescribed sequence of board lanes.

Outstanding versus closed is the working lifecycle distinction; the concrete agent-facing state model is not finalized. Planned/unplanned attention has not yet been specified as task fields, linked requests, or another concrete representation. Activity, readiness, and priority still need their exact data and API contracts; current assignment and liveness-based release are described above. The table records the information wanted in views.

| Fact | Meaning | View supported |
| --- | --- | --- |
| Lifecycle | Active or closed | Outstanding versus resolved work |
| Activity | Who is actually working now | What is happening |
| Readiness | Prerequisites satisfied; available to start | What can be picked up next |
| Required action | A concrete unresolved need directed to someone | What needs attention |
| Origin | Planned handoff or unplanned escalation | To-do versus alert |
| Priority | Urgency, with P0 requiring immediate attention | Ordering and notification rules |

P0 through P4 was suggested as a familiar scale; exact levels and notification behaviour remain open. Planned versus unplanned does not itself determine urgency. Assignment alone does not establish activity. A work item can appear in multiple views while separate parts proceed or await decisions.

Attention is needed when agents cannot progress among themselves, for example because browser access is missing or a product decision or destructive action requires a person's authority. An expected handoff becomes a to-do; an unexpected impediment raises an alert. Acknowledgement alone does not satisfy the need. No separate acknowledgement state has been justified.

Separate human and agent task statuses were explored but not adopted. Responsibility and the kind of action required may be more useful than actor-specific status fields. The detailed agent-facing view is still to be designed.

## Grouping and shared context

Grouping must support progressive disclosure and avoid copying the same bounded context into every work item. A person or agent needs to understand the local work and its relationship to broader purpose, constraints, and decisions.

Each task has one contextual home and inherits its brief from that parent chain. Picking up Investigate XState should reveal its own instruction alongside the shared purpose Build a reusable workflow engine, without copying that brief into every task. A shared brief may be introduced retrospectively to describe the work's broader purpose. Exact disclosure and context-edit rules remain open; depth windows or pagination can be considered if needed. Automatically copying a parent summary into every child has not been agreed.

Context grouping and completion policy are separate decisions. A collection of future improvements need not have the same closure contract as required parts of a deliverable. A child can need review while a sibling is still being implemented; a single exclusive lane can hide one of those facts.

Scope labels can help agents when their meaning reliably supplies obligations or policy. Without that contract, epic versus feature versus task can become arbitrary organizational metadata. The suggested discipline of attaching work to the smallest relevant outcome, and separating independently assignable or verifiable contributions, remains a proposal.

### Task groups

A task group is a distinct, non-actionable domain entity with a title and optional description or shared context. It organizes work without being a task that an agent can claim. Agent work selection exposes actionable tasks; group inspection reveals their context and membership.

Groups contain tasks and nested groups within an acyclic, single-parent hierarchy. Tasks remain leaves. A task may be referenced from other places while retaining one contextual home, one set of findings, and one completion record. Discovering it through a reference still reveals that same home context.

Dependencies and contextual grouping have different purposes. Whether a group can close, whether its descendants must close first, and how workflow-run completion interacts with group lifecycle have not been settled. Group progress can summarize members without proving that its broader purpose was achieved or that its scope is exhaustive. Additional references do not silently add requirements to a task.

Assignable parents were considered for end-to-end delivery accountability and recursive decomposition. The selected discipline instead keeps context and actionable work distinct. Coordination, integration, or synthesis can be an explicit task with prerequisites. This avoids an agent claiming a broad grouping brief while other agents work its members, at the cost of restructuring when a task needs decomposition.

For example:

```text
Workflow engine (group)
  Investigate candidates (task, closed)
  Candidate trials (group)
    Try XState (task)
    Try the alternative (task)
  Compare findings and build the Botlake version (task)
```

Both trials can depend on the completed investigation and run in parallel. The comparison and implementation task depends on both trials, even though they are in a subgroup. Closure of the trials makes their findings available; it does not establish that either candidate succeeded. A subgroup is useful for a shared evaluation brief, not necessary to encode the dependencies.

When existing work becomes too large, the agent may introduce a group and decompose it into tasks. The original task's notes and criterion resolutions must retain what happened to its unfinished scope. Exactly how that restructuring is performed remains open; moving work into a group must not falsely record the original criteria as met.

### Delegation and expansion

A proposed way to expand Build the workflow engine is to retain that original delivery task and its ownership, criteria, and history, then introduce a context group above it if no suitable group exists. Scout tasks become siblings under that group or a research subgroup. The original task depends on the scout results that are genuinely prerequisites. The shared brief lives on the group; each scout task supplies its particular question and expected output.

This can preserve the original delivery obligation without closing it merely because delegation was discovered, and without introducing task-to-task containment. An ergonomic expansion operation could make the structural changes together, but no API shape has been selected.

Tying agent spawning to a task is a possible future improvement, not a prerequisite for every helper invocation. A task expresses the obligation; a run is an attempt to work on it. Run completion alone does not resolve criteria or close the task. Short internal lookups need not automatically manufacture persistent tasks. Messaging can support coordination while task notes, ownership, and dependencies retain its durable results.

## Findings and working history

The field is called **notes**, with terse guidance that it holds conclusions, findings, results, and supporting references. It is optional. A task may need criteria, notes, both, or neither, depending on its purpose. Whether notes are maintained as a current summary, chronological entries, or both remains open.

The reason work stopped can be recorded in notes alongside its results. A separate free-text close reason was considered and dropped because it would duplicate this role.

Diary is enabled in the active lake and was inspected during this discussion. No diary entries have been added for the workshop. The existing [Diary contract](../extensions/diary/README.md) is identity-owned working history across tasks. Its primer calls for useful conclusions to be promoted into the task's current summary; diary entries are not automatically task evidence.

## Common task model

Investigation and delivery types were considered because they could disclose relevant fields and supply defaults or completion contracts. The common cases instead support criteria and notes as independent, optional parts of one task model.

An investigation may need explicit scope and evidence criteria; delivery may need artifact links, verification evidence, and a handoff summary in notes. Types that forbid one of those fields do not fit both cases. New outcomes after a completed spike become new tasks, preserving the earlier record without converting its purpose.

## Finding and connecting prior work

An agent starting an investigation should be able to discover similar previous work, inspect its findings, and reuse relevant context. Search across titles, descriptions, and notes must include closed tasks so completed investigations remain discoverable.

The current lake exposes structured list, readiness, named-query, and edge operations, but no dedicated text-search operation. The [query predicates](../packages/core/src/core/query.ts) support equality, comparisons, existence, membership, and edge filters, without a text-search or substring predicate. Searching descriptions and notes is a requirement for the new model, not an existing search API.

Search results identify potentially relevant work; an explicit relationship records a connection worth retaining. Referencing a completed investigation need not turn it into child work or an unfinished dependency. Context grouping and dependency policy remain separate questions. Exact relationship names, grouping semantics, and agent disclosure rules are still open.

## Use cases and pressure tests

| Case | Implication |
| --- | --- |
| Investigate how statuses work in the application | A supported answer delivered to the requester can satisfy the investigation. The default does not require waiting for acknowledgement unless review or approval was requested. |
| Investigate feasibility and conclude that the idea is infeasible | Criteria can require the answer, evidence, and uncertainty; a favourable answer is not required for a successful investigation. |
| A spike is complete and production hardening is then requested | Keep the spike's notes and completion record. Create new work for the additional scope; grouping is the next design question. |
| An investigation is relevant to another group | Reference the task or its findings while preserving its single contextual home. Extra requirements become explicit new work rather than a second inherited brief. |
| A proposal is no longer wanted | Preserve the actual criterion resolutions instead of marking unsatisfied conditions as met. Notes explain why work ended; closure means no further action is expected. |
| Save a discussion without committing to an outcome | Decide whether this is reference information or an outstanding obligation; saving notes alone need not imply unfinished work. |
| A criterion needs replacement | Preserve the original condition and its resolution, and append a replacement. An assessment of the original condition does not establish that the replacement is met. |

## Next decisions

1. Make planned and unplanned attention concrete, separately from the active/closed task lifecycle.
2. Decide group closure and descendant roll-up separately from workflow execution completion; a delegated composition review will test the current spike against those alternatives.
3. Define how a task is restructured into a group and new tasks while preserving its original scope, notes, criterion history, and references.
4. Define criterion resolution/correction contracts, notes and search ergonomics, and readiness, responsibility, and agent-facing views.
5. Choose criterion storage only after identifying whether independent identity and graph relationships are required. A status or a different assessor alone does not require a separate node.

The Kanban/blockage spike used during this workshop is retained in Git history. The [approved PRD](prd/work-coordination.md) and [current workflow verification](workflow-spike.md) supersede that implementation.
