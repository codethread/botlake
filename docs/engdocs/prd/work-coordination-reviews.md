# Work coordination PRD review

The PRD is a fresh specification from the 30 October 2026 dialogue. Reviews compare the draft with the user's latest decisions, not with old Kanban behaviour. Product approval remains with the user.

## Independent review seats

| Seat     | Configured model         | Effort | First-round verdict                 |
| -------- | ------------------------ | ------ | ----------------------------------- |
| Sol      | openai-codex/gpt-5.6-sol | low    | Revise                              |
| Astra    | openai-codex/gpt-6-astra | high   | Revise with targeted clarifications |
| DeepSeek | deepseek/deepseek-flash  | max    | Revise with targeted clarifications |

Each reviewer read the PRD and user-utterance source packet, with spoken/written context for the decisions. They submitted independently before seeing other findings. The source packet contains 301 spoken segments, including 127 user segments, and the public written dialogue; private reasoning and tool protocol are excluded. The first draft SHA-256 was d7a170526b53e183241e1c3f7b32c5f68e023a7fe5688b1ab9b48dd0e51f01b6.

Detailed reports: [Sol](reviews/work-coordination-sol.md), [Astra](reviews/work-coordination-astra.md), [DeepSeek](reviews/work-coordination-deepseek.md).

## Findings and dispositions

| Finding | Disposition in the revised PRD |
| --- | --- |
| An extra dependency-readiness closure guard was raised as an open decision without user support | Removed. Ordinary closure uses the existing-criteria rule; readiness governs pickup. Workflow action contracts remain separate |
| Workflow atomicity, retry, routing and version-binding details appeared to be approved requirements | Recast as technical integration proposals under the workflow decision. The UML sequence now shows the logical human review interaction without selecting a persistence architecture |
| A task-to-group transformation contract implied transferring task properties onto a non-actionable group | Simplified to preserving the original task record and creating groups/new leaves as needed. No dedicated conversion API is required |
| Human assignment expiry was specified beyond the agent-liveness decision | Removed as an accepted rule. Human release/routing remains an explicit user decision |
| Derived-view diagram made assignment, waiting and HITL views exclusive | Replaced with independent projections. Added owned-but-waiting awareness and routing under the human-contract decision |
| The original awareness view was less explicit than pickup and attention queues | Added outstanding assigned work, current responsibility and readiness/waiting context; assignment is not presented as proof of active execution |
| UML resolution was a string while JSON used an object | Aligned to a Resolution value object; it is not a new independently assignable item |
| References lacked direction/cardinality and an example | Added a minimal non-contextual reference relation, example and read projection; the API spelling remains illustrative |
| Context could be mistaken for a leaf-task closure gate | Explicitly excluded implicit sibling/group gates on leaf closure. Group lifecycle and completion remain unresolved; the review did not settle that policy |
| A completed prerequisite with open or unfavourable prior work might release dependents | Clarified direct prerequisite semantics. Did not add recursive success proof or a new closure gate: the user explicitly chose downstream judgement and recovery |
| A review could close without notes under the generic optional-field model | Preserved generic closure. A process that needs enforced findings can author a criterion or workflow output requirement, rather than introduce a hidden global review type |
| Assigned view might include closed work | Filtered to open assigned work. Did not invent a new requirement to erase or clear assignment information on every closure |
| Checkpoints across two groups had no concrete expression | Added a HITL review depending on explicitly required terminal delivery tasks. This does not define completion of all current/future members of a group |
| API inventory and response-layout prescriptions risked adding ceremony | Reduced to source-backed search, contextual inspection and storage-independent criterion operations; compact response shaping is an ergonomic recommendation |
| Some examples were internally awkward | Aligned the VPN prerequisite with the demonstration task, showed the owner before release, used a finding rather than an instruction in notes, and added automatic closure metadata |

The revised draft keeps only the user-backed state dimensions. The earlier proposals for mandatory criteria, multiple contextual parents, assignable grouping records, extra task types, a second prose close reason, and success-sensitive dependency machinery were not reintroduced.

## Remaining product decisions

- Group lifecycle/completion and how group-based checkpoints identify required scope.
- Intended-human routing and human assignment release, including assisted sessions.
- Origin/priority defaults and notification policy.
- Criterion correction and ordinary recovery details.
- Workflow execution integration beyond the accepted action-outcome distinction.

These are marked in the PRD for user review; peer review does not decide them on the user's behalf.

## Final verification

All three seats returned **ready for user review**, with no remaining material issue. Their second-round reports rechecked the revision against their findings and decisive user dialogue:

| Seat | Final confirmation |
| --- | --- |
| Sol | [No remaining material issue](reviews/work-coordination-sol-final.md) |
| Astra | [No remaining material issue](reviews/work-coordination-astra-final.md) |
| DeepSeek | [No remaining material issue; three minor clarifications](reviews/work-coordination-deepseek-final.md) |

DeepSeek's final clarifications were applied: the current dependency contract remains task-to-task until D1 selects otherwise; the workflow example no longer suggests revision-bound approval is settled; and inspection explicitly exposes group briefs/members and references. The acceptance example now says other members remain open without presupposing a group lifecycle.

Final diagram changes simplify layout without changing the reviewed model: UML focuses on ownership/assignment, while the relation table and parallel-work example define nesting, dependencies and references. The view diagram shows independent projections without crossing priority arrows; priority remains first-class in the fields, view policy and acceptance scenarios.

Verification performed by the primary author:

- Parsed all nine fenced JSON examples successfully.
- Rendered all five Mermaid diagrams in Chrome, including UML relationships and the workflow sequence; visually checked their layout.
- Reviewed all 21 acceptance scenarios for consistency with the selected rules and open decisions.
- Checked Markdown formatting and local document links.

The reviewers inspected Mermaid source; the primary author performed browser rendering. Examples are illustrative logical contracts, not executable schema fixtures. No implementation, migration, or broad product test suite was part of this document review. The pre-existing workflow-spike implementation remains separate work.

Product approval remains with the user. In particular, these confirmations do not select D1-D5 or authorize rebuilding the extensions.
