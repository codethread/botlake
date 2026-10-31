# DeepSeek review — work coordination PRD

**Verdict: revise (targeted).** The model is directionally faithful to the dialogue and substantially simpler than the old board. It is not yet ready for user sign-off because several requirements are either under-specified or contradict the PRD's own entity/read shapes. The fixes below are local; none requires rethinking tasks, groups, or dependency direction.

**Method.** I read the whole PRD, the review guide, all of `user-utterances.md`, and the surrounding spoken/written dialogue from V001 through V301. I did not use existing Kanban/workflow behaviour as a requirement and did not compare against another review. I checked all five Mermaid blocks and the JSON by inspection; no Mermaid renderer is installed in the workspace, so the diagrams were not rendered.

## Prioritized findings

### 1. High — Group containment must explicitly not gate task closure; D1 hides the old child-progression question

**PRD:** R8/R9 (groups are non-actionable context; tasks are leaves), R23 (“no implicit group-completion predicate”), D1 (group lifecycle/checkpoints), and the derived-views prose (“projections, not mutually exclusive”).

**User evidence:** V005 is the motivating complaint: “the subtask can't go into review for someone to look at until … everything moves over, so it sort of constrains the whole thing.” V007/V009 ask for views over states rather than a left-to-right board. V189/V208 make groups purely organizational and non-assignable. V240 says “I don't know if we agreed on whether task closure blocks the parent yet.” V285 is about checkpoints after groups complete, not about ordinary child progression.

**Consequence:** “Group is non-actionable” is not the same as “group containment does not gate closure.” An implementer can read D1 as licence to restore `progression=children`: a task or group cannot close while siblings/descendants remain open. That would recreate the exact over-constraint the user rejected and undermine “only tasks are actionable.”

**Smallest fix:** Add one invariant: “Contextual containment never constrains a task's closure or readiness, and a group has no executable completion requirement in the initial model. Checkpoints are explicit tasks or workflow operations that depend on selected tasks.” Add “does containment ever gate closure?” to D1, and add an acceptance scenario where a leaf task closes while its group and a sibling remain open.

### 2. High — References are required but have no data or API contract

**PRD:** R10 (“Other references may be numerous”), R30 (search/reference/grouping/dependency are four distinct meanings), R32 (task inspection lists ancestors and prerequisites but not references), the class-diagram note (“Multiple dependency/reference edges…”), and acceptance rows “A task is discovered through another reference” and “Previous research may answer a new question … retain a reference”.

**User evidence:** V181 asks to search prior descriptions/notes and says “there might be edges”; V198 says work “can link as much as they want edge to edge”; V188 (assistant) proposed search/reference/grouping as three purposes, which the user did not contest. No user statement settles reference direction, cardinality, or storage.

**Consequence:** The PRD names references as a first-class meaning and tests them in acceptance, but provides no JSON field, no relation in the class diagram, and no read projection. “Retain a reference” and “discovered through another reference” cannot be implemented or verified. The class-diagram sentence claims reference edges that the diagram does not show.

**Smallest fix:** Define a minimal reference relation, e.g. directed or undirected many-to-many edges between tasks and/or groups, explicitly not contributing inherited instructions. Add it to the class diagram, one JSON example, and R32 inspection. If references are deliberately deferred, remove the R10/R30 claims and the two acceptance rows rather than leaving a named behaviour without a contract.

### 3. High — R14's task-to-group reorganization conflicts with the group shape and does not say where criteria go

**PRD:** R8 (group has title and optional description, is non-actionable, cannot be assigned), R9 (tasks are leaves), R14 (“reorganizing an oversized task into a context group and multiple leaf tasks without losing its notes, criteria, identities, or the disposition of unfinished obligations”).

**User evidence:** V208 says an oversized task can be “closed out” and moved into a new group with tasks underneath. V173 says a changed scope is new tasks. V210 confirms tasks stay leaves. No user asked a group to hold criteria or an executable assignment.

**Consequence:** A group cannot hold criteria under R8. If the original task is converted into a group, its criteria/notes have no home; if it remains a closed task, R14 describes close-plus-new-work rather than “reorganizing into a group.” Implementers may either add criteria to groups (violating R8) or silently drop them (violating the preservation goal). “Identities” is also ambiguous: current assignee, assignment history, or both?

**Smallest fix:** Define the operation explicitly: create a context group and new leaf tasks; retain the original task as a closed historical record with notes and criterion resolutions, or explicitly transfer/copy conditions to the new leaves; the group receives only title/description and no assignment or criteria. Add one JSON/acceptance example. This also removes the need for the sentence about the convenience API not silently choosing between two authoring meanings.

### 4. High — R22 requires review findings, but the task model makes notes and criteria optional

**PRD:** R22 (“Review completion means the review was performed and findings recorded”), task table (`notes` optional, `acceptanceCriteria` optional), no review subtype, and the workflow review action JSON (`data.summary`).

**User evidence:** V289: “a review closing is not the same as saying the code is good. … And it will have the notes in it.” V291 treats completion as review-performed, not approval. V285 makes human review planned HITL work.

**Consequence:** An ordinary review task can be closed with no criteria and no notes, so the completion API permits exactly the empty review R22 says it forbids. The human sees “review complete” with no findings. The acceptance scenario “A reviewer finds defects” assumes findings exist, but nothing tests an empty close.

**Smallest fix:** Make “review completion records findings” enforceable at the completion boundary: require a findings note or explicit action payload for a task presented as a review, while keeping approval separate. If that is too much special-casing, weaken R22 to “findings belong in notes; closing does not imply approval” and add a guidance criterion rather than claiming they are recorded. In either case, add an acceptance row for empty review completion.

### 5. Medium-high — Readiness is ambiguous between direct and transitive prerequisites, and its interaction with D4 is unresolved

**PRD:** R16 (“ready when it is open and all its prerequisite tasks are closed”), D4 (whether ordinary closure also requires readiness), R1/R2 (closure only needs criterion resolution), R18 (downstream agents read findings).

**User evidence:** V248/V249 distinguish open from ready: “A task is open, but it's not ready until … all of its dependencies are met”; `ready` is a property, not a status. V274/V276 defer success-sensitive gates and put readjustment on downstream agents. The user did not settle transitive closure or closure-before-readiness.

**Consequence:** If D4 permits closing a task while its own prerequisites remain open, a dependent becomes “ready” on the strength of a closure whose own prerequisites were never settled. If readiness is meant transitively, R16 does not say so. Either way the central selection predicate is under-defined, and agents may be dispatched into incomplete context. This is not a request for success-aware dependencies; it is a lifecycle/readiness consistency question.

**Smallest fix:** State whether R16 uses direct or transitive prerequisite closure, and cross-reference D4. Example: “Ready means all direct prerequisite tasks are closed; closure is the settled signal regardless of how the prerequisite closed. D4 governs whether a task may close with its own prerequisites open.” If D4 is settled the other way, say “closure requires readiness” and make R16 transitive accordingly. Add a test case for a prematurely closed prerequisite.

### 6. Medium — The Assigned view includes closed tasks, and assignee disposition on closure is unspecified

**PRD:** Derived views table: “Assigned — Has a current assignee; may also be waiting on dependencies.” R19 keeps one current assignee and history; R1 says closed means no further action is expected.

**User evidence:** V258 chooses a current assignee plus liveness expiry and history. V262 derives whether something is active from assignment. No user asked closed work to remain in the current-assignee view.

**Consequence:** A closed task that retains its current assignee appears in the “Assigned” view, implying active responsibility. If closure clears the assignee, the PRD does not say so, and history storage is left ambiguous. This is the only derived view predicate that omits `open`.

**Smallest fix:** Add `open` to the Assigned predicate and state that closure clears the current assignee while retaining assignment history, or explicitly justify retaining a current assignee on closed work. One sentence is enough.

### 7. Medium — The derived-view flowchart contradicts overlapping views and omits two gates

**PRD:** The derived views table and “These are projections, not mutually exclusive stored lifecycle stages” versus the flowchart, which is a single decision tree; its HITL branch goes straight to “Ready human action queue”; priority links only to Planned/Unexpected views.

**User evidence:** V009/V048 describe views composed from distinct states; V025-V029 say attention, awareness, and upcoming work can coexist. V280/V285 require HITL work to reach the human. V046/V294 make priority first-class for ordering and notifications.

**Consequence:** The diagram implies disjoint views. A task that is ready and assigned is routed to “Assigned” and never shown in pickup; an assigned task waiting on a prerequisite is routed to “Waiting” and never shown as assigned, although the table says both apply. HITL is shown in the human queue without the “directed to the viewing person” condition in the table. Priority appears to matter only for human views, while the prose says it orders queues generally. Implementers can easily build the diagram rather than the table.

**Smallest fix:** Label the flowchart as one navigation path, or replace it with overlapping set membership; add the “directed to this person?” gate for HITL; show priority ordering all queue views, not only planned/attention. Keep the table as the normative predicate list.

### 8. Medium — R27/R28 carry an undefined legacy clause and an assistant-only safety requirement

**PRD:** R27 (“Preserve matching-result retry behaviour without silently accepting conflicting outcomes”) and R28 (“Approval should identify the reviewed artifact/revision so later changes do not silently reuse it”).

**User evidence:** V289/V291 ask for review closure to be distinct from approval and for workflow action outcomes to drive branching. The user never mentions retry matching or revision identity. V298 explicitly says existing functionality/behaviour is not a requirement. “Matching-result retry” is not defined anywhere in the dialogue or PRD.

**Consequence:** Implementers are told to preserve an undefined old workflow behaviour, contrary to the fresh-model instruction. Revision identification is a sensible workflow-specific safety property, but it is stated as a requirement without a user decision or a payload contract; it may add ceremony the user did not ask for.

**Smallest fix:** Delete “matching-result retry” or move it into D6/implementation notes as an open engine contract. Mark revision identification as a proposed workflow-specific rule for user review (or drop it); do not present it as settled. The rest of R27's atomic-validation requirement is supported by the user's review/workflow discussion.

### 9. Medium — V285's “checkpoint after two groups complete” has no concrete expression

**PRD:** R23 (“The product must support checkpoints across work in several groups and further fan-out afterward … explicit task prerequisites can express the required scope”) and D1.

**User evidence:** V285: “once these two task groups are complete, put a dependent review task in, and then you can fan out and do the rest of the work after it.” V240 says group closure is not agreed.

**Consequence:** D1 correctly defers group lifecycle, but the draft never shows how to express the checkpoint the user actually asked for. “Depend on explicit tasks” is plausible, but without an example implementers may invent a group-completion object or omit the checkpoint. No JSON, diagram, or acceptance scenario covers it.

**Smallest fix:** Add a small example in which a review/checkpoint task depends on the terminal required task in each of two groups (or on a small explicit set of leaves), and an acceptance row that verifies fan-out only after the checkpoint. This preserves D1 while making the supported mechanism concrete.

## Unresolved user decisions the draft hides or mishandles

- **D1 is genuinely open, but too narrow.** The draft asks what makes a group complete and whether a task can depend on it. It does not ask whether group containment itself gates child/sibling closure, which is the user's original V005/V240 concern. Add that to D1 and state the non-gating default explicitly.
- **D2 is genuinely open.** R21 and the “planned human review” scenario say work is “directed to that person,” but no routing field is defined and the JSON uses `assignee`. The derived-views note defers this to D2; R21 should too. In particular, say what happens when the assignee is an assisting agent rather than the human.
- **D3 is genuinely open** and is handled well: planned/P2 are labelled recommendations, while P0-immediate and urgency independent of origin are supported (V046/V294). Do not let the illustrative JSON make P2 look settled.
- **D4 is genuinely open**, but it is coupled to R16. The draft should not present R16 as a complete readiness rule while D4 could permit closure with open prerequisites. State the chosen interaction or explicitly say the predicate uses closure as-is.
- **D5 is mostly clear**, but its “notes as editable summary versus history” sub-question is largely answered by R6 (“Notes are not required to be append-only”). Either remove that sub-question or state the default and keep only criterion corrections/reopen genuinely open.
- **D6 is genuinely open.** The “matching-result retry” phrase belongs here, if anywhere, rather than in a requirement. Review-action revision identity could also be a D6 sub-decision.
- **Not still open, and worth preserving as settled:** blockers via ordinary prerequisite tasks (V291, supported by V274/V276), optional criteria with all existing criteria resolved (V173, superseding V129), no close-reason field (V178/V181), one task model without epic/feature/investigation/review subtypes (V063/V173), single contextual parent plus task leaves (V198/V210), non-actionable groups (V189/V208), review closure not approval (V289/V291), and priority as an independent first-class field (V046/V294).

## Important sound choices to preserve

- One task model, with optional criteria and notes; no requirement to fabricate criteria; no close-reason field; record closer/time; criteria conditions retained with explicit resolutions and no forced met/unmet status enum.
- Groups are context only, non-assignable; tasks are leaves; one contextual parent; dependencies are separate, cross-group, task-to-task, and acyclic.
- Readiness is derived rather than a stored status; ordinary prerequisite tasks carry impediments; success-sensitive dependency states and a second blocker ledger are deferred.
- Assignee is current responsibility/reservation, not proof of live execution; liveness expiry releases only the assignment and preserves task history.
- AFK is the audience default; HITL is human participation, not approval; origin is independent of priority; P0 is immediate attention without an invented SLA.
- Review completion is not code approval; workflow actions are explicit outcomes rather than global task statuses; agent-run completion is not task completion.
- The PRD correctly ignores migration, feature parity, old Kanban lanes, and compatibility; the open decisions are labelled rather than silently inherited.
- Search across closed descriptions/notes, compact reads with expandable ancestor context, and retrospective groups are strong responses to V181/V193/V195 and should remain.

## Checked JSON, diagrams, and acceptance scenarios

**JSON.** I checked each object against the model table and R1–R32. The delivery task, VPN prerequisite, `parent-of`/`depends-on` edges, criterion resolution, and review action otherwise agree with the prose. Concrete issues:

- The delivery task has `"assignee": null`, but the prose says “Releasing its assignee does not make it eligible for pickup.” Either assign it in the example or change the sentence to “Being unassigned does not make it eligible.”
- There is no `references` field or edge anywhere, despite R10/R30 and two acceptance rows.
- There is no read example showing ancestor context, even though R11/R32 make it a core inspection contract.
- `kind` appears on group/task JSON but not in the task table or class diagram.
- The class diagram types `resolution` as `String`; the JSON uses an object with `text`/`by`/`at`. Add a `Resolution` value object or align the JSON.
- The class diagram has no `closedBy`/`closedAt` relation despite R3, and no reference relation despite the diagram note.

**Diagrams.** The class, state, flowchart, and sequence syntax appears valid by inspection; no renderer was available. Cardinalities are broadly right: one optional parent for a group/task, many children; one task owns many criteria; many tasks may share an assignee; tasks have many-to-many dependencies. Problems are semantic: the flowchart is a disjoint decision tree over overlapping views; the sequence diagram labels the agent worker as Mermaid `actor` (a human figure) although the worker is not necessarily human; `All existing criteria resolved` on the Open→Closed edge is vacuously true for zero criteria but can be misread as a minimum-one rule; D1's “can a task depend on [group] completion?” conflicts with R12's statement that dependencies connect tasks. Use `participant Worker`, say “no unresolved criteria,” and make D1 explicitly a future exception to R12 or keep task-only dependencies.

**Acceptance scenarios.** I checked all sixteen rows against the requirements. Most are well aligned. Missing or weak coverage:

- No scenario for ancestor context/retrospective groups (V193/V195), which is a central no-duplication requirement.
- No scenario for group membership not gating task closure (V005/V240).
- No scenario for priority ordering or P0 versus P2 (V046/V294); the flowchart only suggests urgency for human views.
- No scenario for a criterion resolved as `unmet` while the task still closes with the outcome visible (V125/V173), although R1/R5 permit it.
- No scenario for reference retention beyond “same contextual home,” and no reference contract to test.
- “An agent tries to claim a group or parent work beneath a task” is confusing because tasks are leaves; “claim a group or any non-leaf container” is enough.
- The “human-only VPN” row says to suppress unattended pickup of the human task; that is already implied by HITL and could be simplified.

**Intent trace.** Add V005/V007/V009 (over-constraint/views), V181 (search/references), V264 (blocked request, even though V291 settles the task-prerequisite approach), and V283 (review composition) to the trace. V193/V195 and V206/V208 are present; the trace is otherwise usable.
