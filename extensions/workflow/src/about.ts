export const workflowAbout = `# Workflow authoring

Botlake projects authored XState machines into Work tasks, groups and gates.
Use bl about workflow for authoring and configuration; bl prime workflow is the execution runbook.

## Organize and register

Keep definitions in .botlake/workflows/NAME.ts.
Build and default-export each definition with defineWorkflow.
Register imports from a configured module such as .botlake/workflow.ts:

    import { workflows } from "@botlake/extension-workflow";
    import review from "./workflows/review.ts";
    export default workflows({ definitions: [review] });

Select that configured module, Identity and Work in .botlake/package.json.
The workflows folder is an organizational convention, not an auto-discovery mechanism.
Imports are inert; registration and extension selection are explicit.

## Put the process in XState

Give each state one action or decision, a clear title and an observable completion outcome.
Use meta.commands for authored choices and XState on transitions for their consequences.
Split decisions from execution instead of burying conditional paths in task prose.
Use distinct outcomes such as approved and not-approved rather than done for every decision.
For example, an approval state's choice and transition metadata is:

    meta: { commands: { approved: "APPROVED", "not-approved": "NOT_APPROVED" } },
    on: { APPROVED: "merge", NOT_APPROVED: "review" },

The resulting flow is visible without reading the task instructions:

    approval --approved--> merge --> version --> sync --> refresh --> done
        |
        +--not-approved--> review --resolved--> approval

Review resolution returns to the approval decision; closing a review does not imply approval.
Use guards, context, parallel states or nesting when the process needs them, not prose-based substitutes.

## Keep instructions small

Write short, complete sentences that fit roughly within 120 source columns and read well in an IDE.
Rewrite long sentences instead of splitting them across concatenated strings.
Describe the objective, local constraints and completion evidence.
Trust agents to know SemVer, Git and other standard tools; spell out only workflow-specific policy.
Refer to repository guidance for merge and deployment procedures rather than prescribing their implementation.

## Make human and machine blockers explicit

For approval workflows, require user sign-off for the exact candidate, renewed if the candidate changes.
Ask directly during a live conversation; AFK agents create or reuse an unplanned HITL task assigned to the user.
Link the review as a Work prerequisite of the step it blocks, and advance through an explicit approval choice.
Use Work gates for machine-checkable conditions instead of instructions to wait or poll.
A downstream Work task exists only after its state is published; attach prerequisites to an existing task.

## Finish at the real outcome

Include the final operational step, not just the last code change or commit.
For example, a release may need a fresh bundle and a running server restart after the push.
If the server and restart method are clear, restart it; otherwise ask the user or add a blocking HITL task.
Instructions describe these actions; importing a workflow does not perform them or launch agents.

Exercise both decision branches, review loops, blocked paths and the terminal outcome in a disposable lake.
Bump the definition version when changing a persisted definition, and finish in-flight runs before replacing it.
`;
