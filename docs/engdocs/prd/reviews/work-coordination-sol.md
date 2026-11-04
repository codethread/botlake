# Sol review: work-coordination PRD

## Verdict: revise

The core model is notably faithful: one open/closed task lifecycle; optional retained criteria; notes for results; non-actionable nested groups with task leaves; independent dependencies; assignee/liveness; AFK/HITL, origin, and priority; and workflow-local action outcomes. The draft also handles the important supersessions correctly. It is not quite ready for user review because several workflow and restructuring policies are presented as settled requirements even though they came only from assistant suggestions or were not discussed, and D4 reopens a task-closure rule the user had already simplified rather than identifying a genuine user decision.

## Prioritized findings

### 1. Remove D4 rather than asking the user to decide an invented readiness gate

- **PRD:** “Lifecycle and closure” says the universal closure rule is criterion resolution but then D4 asks whether ordinary manual closure also requires dependency readiness. D4 repeats that question.
- **Dialogue:** V173 explicitly simplifies closure to: criteria are optional, but every criterion that exists must be resolved. V248-V249 define readiness as a derived pickup property based on dependencies. V274/V276 explicitly prefer downstream judgement over additional dependency machinery. There is no user statement proposing that an unready task cannot close. The only closure uncertainty the user explicitly names is **group/parent closure** at V240.
- **Consequence:** D4 invites exactly the extra global constraint and ceremony the user was trying to avoid. It also blurs the PRD’s otherwise clean distinction between lifecycle and readiness and risks preventing an agent from honestly ending work that has been superseded or cannot proceed.
- **Smallest useful fix:** Delete D4 and the corresponding caveat. State the settled ordinary rule already supported by R2: closure requires resolution of existing criteria; readiness governs pickup, not closure. Keep group completion in D1 and workflow-specific completion checks in the workflow section.

### 2. Recast the detailed workflow consistency/retry machinery as proposals, not dialogue-backed product requirements

- **PRD:** R25-R28 and the sequence diagram require preserved actor routes/original workflow results after context moves, one atomic task/workflow completion operation, atomic publication, “matching-result retry behaviour,” fresh records for every revision, and revision-bound approval payloads.
- **Dialogue:** V289/V291 supports only the essential semantic seam: closing a review means the review happened, while a workflow uses its own explicit action outcomes to branch and can create new work. The explicit approved/changes-requested examples and revision identity were assistant suggestions at V288/A035, not explicit user decisions. Atomic persistence, retry semantics, actor-route stability, and rollback behavior are absent from the user dialogue. V298 asks for a fresh PRD, not parity with the existing workflow implementation.
- **Consequence:** A simple product model quietly becomes a transaction, idempotency, routing, and workflow-runtime specification. Implementers could treat speculative mechanics as approved scope, while the user is not shown which choices still need agreement.
- **Smallest useful fix:** Keep R24, the separation of lifecycle closure from explicit workflow action, and the requirement that the two not produce a visibly contradictory result. Move atomicity, retry behavior, revision-bound approval, fresh-record revision loops, and route stability into a clearly labelled “workflow contract proposals to validate” subsection or D6. Simplify the sequence diagram so it illustrates the proposed boundary rather than asserting a transaction architecture.

### 3. R14 invents a lossless task-to-group transformation contract the user did not settle

- **PRD:** R14 requires support for reorganizing an oversized task into a group and leaves “without losing its notes, criteria, identities, or the disposition of unfinished obligations,” followed by two authoring choices and a required convenience API that must not choose between them.
- **Dialogue:** V208 says an agent can close the task and “move this over to a group” when it becomes too much. V226-V235 explores a different option: retain the original delivery task and add scout siblings/subgroups. The user never settles a conversion operation, lossless movement of task fields onto a non-actionable group, an “unfinished obligations” model, or a convenience API. The assistant alone adds preservation language at V215.
- **Consequence:** This is both overengineered and semantically unclear: groups deliberately cannot own criteria or assignment, so “without losing” those task properties cannot mean transferring them to the group. It could force a complex conversion API before the ordinary create/link/close operations have been tested.
- **Smallest useful fix:** Replace R14 with the modest invariant supported by V173/V208: preserve the original task record; create a group and new leaf tasks as needed; explicitly resolve any retained criteria before closing the old task. Mention retaining the original delivery task plus delegated prerequisites as an alternative example, not a mandated convenience API.

### 4. Human assignment expiry is asserted beyond the user’s liveness decision

- **PRD:** R19 states, “Human assignments are not expired merely because a human has no agent heartbeat,” and additionally requires exact concurrency behavior for claims/liveness events.
- **Dialogue:** V258 explicitly selects programmatic release for agents that stop heartbeating or are known gone, with history retained. It does not define human assignment expiry, human presence signals, or race semantics. D2 correctly admits that intended-human routing remains unresolved.
- **Consequence:** The PRD settles one side of the still-open human routing/liveness contract and may create indefinitely reserved HITL work. The concurrency invariant is sensible engineering, but is not an accepted product decision from this workshop.
- **Smallest useful fix:** Limit the requirement to agent assignments as stated in V258. Put human release/expiry under D2 (or a small liveness decision), and label compare-and-set/concurrency handling as an implementation correctness proposal rather than user intent.

### 5. The derived views imply more routing and notification behavior than the model currently defines

- **PRD:** The Human action queue is “directed to the viewing person”; R21 says a review is directed to that person; the text says priority “drives configurable notifications”; the planned human review acceptance scenario requires surfacing to the intended person. Yet D2 says the intended-human data contract is unresolved, and D3 leaves notification preferences and priority meanings open.
- **Dialogue:** V025-V029 asks to see attention, current activity, and upcoming work; V037/V039 distinguishes planned from unplanned; V046 says priority gives the ability to set up notifications; V280 makes HITL work need the user and suggests assignment. It does not settle multi-human routing, assisting-agent ownership, notification configuration, or notification triggers.
- **Consequence:** Readers cannot tell which queue behavior can actually be implemented from `assignee` and which depends on D2/D3. “Drives notifications” reads as a settled subsystem requirement even though the user only required priority as an input that can support notifications.
- **Smallest useful fix:** Make current examples explicitly single-human and assignee-routed pending D2. Say priority is available to order views and notification policy, not that configurable notifications are part of this initial contract. Keep the user’s visibility goals, but mark delivery/channel policy as later work.

### 6. The draft is much more prescriptive than its “terse, familiar concepts” principle requires

- **PRD:** R29-R32 specify broad CRUD operations, compact/deep read behavior, group nested summaries, stored-versus-derived disclosure, and search across task titles plus group fields. R10 introduces an unrestricted “other references” relationship; R15 defines run/task coupling; several implementation contracts are interleaved with the core model.
- **Dialogue:** V173/V175 emphasizes not teaching agents a long bespoke schema. V181 explicitly requires search through prior descriptions and notes; V198 distinguishes arbitrary links from the one contextual parent; V229 calls task-linked spawning a future improvement. The exact API operation inventory, response expansion design, title/group search scope, and reference-management API were not selected by the user.
- **Consequence:** The core decisions are harder for the user to review, and inferred ergonomics can be mistaken for settled requirements. The 32-rule draft risks becoming the bespoke system it says to avoid.
- **Smallest useful fix:** Keep search of closed task descriptions/notes, ancestor context on reads, and the distinctions among context/dependency/reference. Collapse R29-R32 into a short “minimum ergonomic surface” proposal and move response-shaping/API inventory to implementation design after approval. Keep task-linked spawning explicitly future-only.

## Genuinely unresolved user decisions

The draft correctly exposes several real decisions, but should tighten their boundaries:

1. **Group completion/checkpoints (D1):** genuinely unresolved. V240 says it was not agreed; V285 requires checkpoints after groups but does not define completion. Preserve this as the main product question.
2. **Intended-human routing (D2):** genuinely unresolved once there can be multiple humans or an assisting agent. A single-human/assignee example is fine if labelled as such.
3. **Origin/priority defaults and notification policy (D3):** genuinely unresolved. `planned`/`P2` are appropriately recommendations, not accepted defaults.
4. **Recovery/correction (part of D5):** reopening is mentioned as a possible downstream response at V274/V276, but criterion correction and reopen semantics were not selected. This can remain open, though it should not imply reopening is mandatory in the initial product.
5. **Workflow/run relation (D6):** genuinely unresolved beyond the accepted separation of task closure from workflow action outcome.

D4 is not a genuine dialogue-derived decision and should be removed. R14’s conversion semantics and R27’s retry/transaction semantics are additional hidden decisions that should either be removed or moved into D5/D6 as proposals.

## Important sound choices to preserve

- Correctly supersedes V129 with V173: zero criteria are valid, but every added criterion must be explicitly resolved.
- Keeps original criterion conditions/history while allowing “no longer required,” without inventing passed/failed criterion statuses.
- Uses notes for conclusions/findings/results and rejects a duplicate prose close-reason field (V173-V181).
- Uses one task model rather than investigation/review/feature subtypes.
- Preserves the decisive one-contextual-parent rule and nested group/group-or-task containment, with tasks as non-containing actionable leaves (V198, V208, V210).
- Separates contextual nesting from dependency order and models the parallel-trial join accurately (V206-V210).
- Treats readiness as derived, closure as not necessarily success, and lets downstream agents interpret unfavourable prerequisite results rather than adding success-sensitive dependency gates (V248, V274, V276).
- Makes assignee separate from lifecycle/readiness and preserves agent assignment history when liveness releases ownership (V258-V262).
- Keeps AFK/HITL, planned/unplanned origin, and priority independent (V037-V046, V280, V285, V294); AFK is the only user-selected default.
- Correctly separates completion of a review from approval and keeps workflow actions local to authored workflows (V289/V291).
- Clearly labels group lifecycle, origin/priority defaults, criterion storage, and several recovery details as unresolved rather than inheriting old Kanban behavior.

## JSON, diagram, and acceptance-scenario checks

### What I checked

- Parsed all **five** fenced JSON examples with a JSON parser; all are syntactically valid.
- Inspected all **five** Mermaid blocks for consistency with the prose: task state, class relationships, parallel dependency graph, derived-view flow, and workflow completion sequence.
- Cross-checked every acceptance scenario against R1-R32 and the cited user segments, with particular attention to optional criteria, invalid containment, dependency closure, liveness release, HITL routing, review outcomes, and workflow consistency.

### Results

- The task state diagram is consistent with optional criteria under vacuous “all existing criteria resolved,” but its recovery arrow is correctly only a proposal. If D4 is removed, no readiness guard should be added to this diagram.
- The class diagram correctly shows groups containing groups/tasks, task-to-task dependencies, task-owned criteria, and at most one current identity per task. It does not show the one-contextual-parent constraint or acyclicity; the prose does, so this is acceptable, though a note would prevent readers treating the multiplicities as the full invariant.
- The parallel-investigation diagram matches V206-V210 and clearly distinguishes context boxes from dependency arrows. Preserve it.
- The derived-view flow is mostly sound, but it cannot implement “directed to the viewing person” until D2 is chosen. Label that routing assumption in the diagram/text.
- The workflow sequence diagram currently implies atomic persistence and a specific controller architecture not selected in dialogue; revise it with finding 2.
- JSON consistently uses `open/closed`, AFK/HITL, planned/unplanned, and P-level priority. The proposed `planned`/`P2` defaults are used in examples and are labelled recommendations elsewhere; add a nearby reminder so examples are not mistaken for settled defaults.
- The VPN example is internally awkward: `task-demo` is described as using candidate investigations, while `task-vpn` says “the investigation” cannot reach the environment, yet the dependency is from the delivery task to VPN. Also `task-demo.assignee` is already `null`, so “releasing its assignee” describes a transition not shown by the object. Either change the wording to say delivery needs VPN and show an assignee before release, or use a separate investigation task.
- The acceptance scenarios faithfully cover the core accepted model. The workflow validation scenario asserts the sensible consistency goal but inherits the unsupported atomic/runtime detail from R27. The planned-human-review scenario should say “under the chosen D2 routing contract” rather than presenting intended-person routing as already settled.
