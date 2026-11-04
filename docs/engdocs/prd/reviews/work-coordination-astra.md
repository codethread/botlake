# Astra independent PRD review

## Verdict: revise

Make a small clarification pass before presenting the draft: the derived-view diagram contradicts the orthogonal model, and part of the workflow section presents an unselected retry/implementation contract as settled. The underlying product model is strong and faithful to the later user decisions; neither issue calls for a redesign. The explicitly open decisions are appropriate for a draft intended for user review.

Reviewed `docs/prd/work-coordination.md` in full, independently, without reading another review. Reviewed all of `user-utterances.md` and `written-dialogue.md`, plus surrounding spoken segments V020–V054, V170–V213, and V220–V301. Applied AGENTS.md, the review guide, robustness guidance, and documentation guidance. No historical dialogue requests were executed.

Reviewed PRD SHA-256: `d7a170526b53e183241e1c3f7b32c5f68e023a7fe5688b1ab9b48dd0e51f01b6`.

## Prioritized findings

### 1. P2 — The derived-view flowchart makes overlapping facts look like exclusive routes

- **PRD:** “Derived views,” lines 174–200, especially the path to `Assigned view` at lines 188–194; R19 and R21.
- **Evidence:** V048 chooses composable dimensions instead of prescribed stages. V248–V258 distinguish open, ready, and assignee. V280 and V291 require human participation and actionable human review visibility, not a replacement lifecycle. The PRD table itself explicitly allows assigned work to be waiting.
- **Problem:** The diagram reaches `Assigned view` only for **ready AFK** work. An assigned task with an open prerequisite goes only to `Waiting view`; an assigned HITL task goes only to the human queue. It also sends every ready HITL task directly to the human queue without the table's “directed to the viewing person” condition. The adjacent sentence says projections are not mutually exclusive, but the visual tells a different story.
- **Practical consequence:** A view implementation copied from the diagram could hide responsibility for blocked work and exclude assigned human work from assignment views, or surface other people's HITL work in a personal queue.
- **Smallest useful fix:** Show assignment as an independent projection, and make human routing conditional on the intended recipient under D2. Alternatively, label the diagram strictly as pickup/action routing and remove its claim to represent the Assigned view. Add one acceptance example of a task simultaneously assigned and waiting; do not add a new status.

### 2. P2 — Workflow retry policy and transaction architecture are not distinguished from accepted product requirements

- **PRD:** R27, particularly “Preserve matching-result retry behaviour,” and the workflow sequence diagram at lines 228–242.
- **Evidence:** V236 asks whether the model composes with workflows; V289/V291 support explicit workflow outcomes and fresh follow-up work. V298 explicitly excludes existing behaviour as a requirement. There is **no user decision selecting matching-result retry semantics**, nor one requiring a particular database transaction/checkpoint architecture. A002 describes old atomic behaviour, but that is historical assistant evidence, not product authorization.
- **Problem:** R27's consistency goal is useful: a successful workflow completion should not leave closure, the recorded action, and subsequent work disagreeing. But “preserve” imports an unspecified prior retry contract. The sequence diagram then makes a single transaction over execution, checkpoint, closure, and publication look like a settled architecture rather than an illustrative way to achieve consistency.
- **Practical consequence:** Implementation could treat compatibility with an old completion API, or a particular persistence boundary, as mandatory despite the fresh-model instruction. The user cannot tell which part they actually selected and which part the drafter recommends.
- **Smallest useful fix:** Keep the observable consistency requirement and validation-failure scenario. Move duplicate-submission/retry semantics into D6 or label them as a proposal. Mark the transaction sequence as an implementation illustration, or show logical completion effects without prescribing the persistence mechanism. Do not add more recovery machinery to this PRD.

### 3. P3 — “What is happening?” is less concrete than the other two original human views

- **PRD:** Introduction; R19's “actual live execution can be observed separately where needed”; Derived views; acceptance scenarios.
- **Evidence:** V025–V029 ask for awareness of current work alongside attention and upcoming opportunities. V054 agrees with the preceding three-view sketch. V262 later suggests deriving activity from assignee. These support an awareness projection, not necessarily a new execution-status subsystem.
- **Problem:** The draft thoroughly specifies pickup and human-action queues, but only indirectly represents awareness through `Assigned`. It correctly warns that assignment can mean reservation or waiting, then makes actual execution visibility an optional aside. It never plainly states what the user's “happening now” surface promises to show.
- **Practical consequence:** A product could satisfy every listed scenario while leaving the user with attention and backlog queues but no clear account of current responsibility/progress. Alternatively, a UI might misleadingly label every assignment as actively running.
- **Smallest useful fix:** Explicitly map awareness to a compact view of outstanding assigned work with readiness/waiting context, making clear that it is not proof of execution. If a stronger live-activity signal is desired, mark that as a user decision rather than inventing a status. One scenario should show how owned-but-waiting work remains visible and how expiry changes that view.

### 4. P3 — Criterion resolution has two incompatible illustrative types

- **PRD:** UML `Criterion.String resolution`, line 112, versus “Retained criterion resolution,” lines 327–340.
- **Evidence:** V173 supports retained conditions and explicit resolutions; V138 deliberately leaves representation behind an ergonomic API. No user decision settles the exact resolution shape. The PRD itself labels attribution/time as proposed logical fields.
- **Problem:** The UML says `resolution` is a string; the JSON says it is an object with `text`, `by`, and `at`. This is a logical API-shape mismatch, not the intentionally deferred embedded-versus-graph storage question.
- **Practical consequence:** Two readers could implement different completion payloads while each believes they followed the illustrated contract.
- **Smallest useful fix:** Remove the specific string type from the UML resolution member or align it with the proposed object. Keep flexible resolution text and proposed attribution; no additional entity or status taxonomy is needed.

## Unresolved user decisions

- **Group completion is genuinely unresolved and is handled honestly.** V240 explicitly leaves it open; V285 requests checkpoints after groups complete without defining completion. D1, the group JSON omission, and the prose caveats correctly preserve this. Explicit leaf-task prerequisites are a useful interim expression of a checkpoint's scope, not a settled answer for a group's changing membership. Do not convert the interim example into a permanent ban on group-completion dependencies.
- **Intended-human routing remains a real decision.** V280 includes doing HITL work _with an agent_. D2 correctly asks whether one assignee also identifies the intended human. The decision needs to cover an assisting agent without losing the person's queue entry. The draft does not need a speculative second owner field; it does need the diagram to respect the unresolved routing contract rather than bypass it (finding 1).
- **The retry contract is a hidden decision, unlike the above.** D6 should absorb or explicitly propose it (finding 2). Outcome-driven branching does not by itself determine duplicate-completion behaviour.
- **D3–D5 are appropriately exposed rather than omissions.** Planned/P2 defaults, notification preferences, closure versus readiness, reopening, and criterion correction should not be treated as user-approved already. The draft need not resolve them to be reviewable. In particular, do not invent success-sensitive dependency gates to answer D4 or D5.

## Important sound choices to preserve

- Optional notes and criteria, including zero-criterion closure, with every added criterion resolved and its original condition retained: V173 supersedes V129 correctly. Resolution is not forced to mean success.
- Description / criteria / notes have distinct, terse roles; there is no duplicate close-reason field or mandatory independent verifier (V103, V173–V181).
- Canonical assignable task leaves and nonassignable nested groups, one contextual parent, many references, and independently directed dependencies faithfully follow V198/V208/V210. Retrospective context and compact inspection address V193/V195/V233.
- Ordinary prerequisite tasks carry blockers; expiry releases ownership without erasing the impediment. No separate blocker ledger or success-aware dependency taxonomy is added (V258, V271, V274/V276).
- Audience, origin, priority, readiness, lifecycle, and assignment remain distinct in the prose. AFK defaults correctly; a last-minute expected review remains planned; unplanned is not automatically urgent (V280/V285/V294).
- Human review completion is not approval. Explicit workflow action outcomes drive follow-up work, while merge approval constrains the relevant boundary rather than stopping implementation or honest review (V264/V289/V291).
- Workflow work uses canonical tasks rather than another public ownership ledger; execution identity is separate from contextual nesting. This is a sensible composition design, not a reason to inherit old adapter policy.
- Task-linked spawning remains future integration, not a requirement for every helper invocation (V229). Closed research remains searchable and reusable (V181).

## JSON, diagram, and acceptance-scenario checks

### JSON

Parsed **all five JSON fences** with Python's standard JSON parser; all are syntactically valid. Also manually checked:

- The group has neither executable ownership nor task criteria, and does not silently settle its lifecycle.
- The delivery task uses open/AFK/planned and an unresolved optional criterion; P2 is explicitly only a proposed default elsewhere.
- The VPN example uses ordinary HITL work and correct graph direction: group → task for containment; dependent delivery task → VPN prerequisite for dependency. Both referenced tasks and the group are identified in the examples. Releasing assignment cannot remove the open dependency.
- The retained resolution preserves the delivery criterion's original condition. Its object shape conflicts with the UML as noted in finding 4.
- The review action uses a workflow-specific `revise` choice, not a global task state. Its isolated task identifier is a reasonable illustrative fragment, not an allegedly complete executable fixture.

The VPN human assignee is acceptable as the explicitly labelled D2 recommendation; it does not establish the general assisted-HITL routing contract. The delivery notes' “Record the demonstration … here” wording is an instruction rather than an actual result; replacing that sentence with a concrete interim finding would make the notes example teach its intended role more cleanly, but this is editorial rather than a product defect.

### Diagrams

Manually checked **all five Mermaid blocks** for model semantics; **did not render them or run a Mermaid parser**.

- Lifecycle: keeps open/closed and labels reopening as D5; its closure arrow should be read with the following D4 caveat, not as a complete workflow-completion contract.
- UML: containment cardinalities, task leaves, many-to-many dependencies, optional single assignee, and task-owned criteria match the prose. Resolution type does not.
- Parallel investigation: both trials depend on the survey; delivery depends on both trials. Boxes supply context, not ordering. Stored dependency direction is explicitly explained and correct.
- Derived-view routing: contradicts overlapping assignment semantics and omits personal routing (finding 1).
- Workflow sequence: captures consistent completion effects but unnecessarily looks like a settled persistence architecture (finding 2).

### Acceptance scenarios

Read and cross-checked **all 15 rows** against the requirements and source decisions. They preserve optional criteria, explicit criterion retirement, leaf-only grouping, one contextual home, parallel joins, unfavourable prerequisite results, assignment expiry, human blockers, planned reviews, review-versus-approval, operation-boundary gating, new scope, research reuse, and consistent workflow failure behaviour.

They do not exercise the overlapping assigned/waiting/HITL combinations behind finding 1 or explicitly demonstrate the original awareness view. One combined scenario can cover these without expanding the state model. A further useful example, if space permits, is R14's active-task decomposition with unfinished criteria preserved; the completed-spike row tests a different case. None of these checks establishes empirical improvement over historical agents.

## Scope of actions

Inspected the existing Botlake review task using registered identity `responsible-related-jay`; created no task and closed neither this task nor its parent. Wrote only this assigned report. No PRD, source packet, source code, or other reviewer report was changed; no broad test suite or delegation was run.
