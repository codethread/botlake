# Work blockage protocol

Kanban and Workflow implement this convention independently, through their own `block` and `unblock` commands. Neither imports the other's implementation. Core supplies graph storage and transactions, not domain policy.

A blockage is a durable node with `work/blockage: true`, its owning `work/domain`, `work/reason`, `work/raised-by`, optional `work/needed-from` and `work/raised-at`. One retained `blocks` edge points from the blockage to its work target. Active records are unresolved; resolution closes the record and adds `work/resolution`, `work/resolved-by` and `work/resolved-at`. Original facts and links remain immutable. Resolution requires the owning domain's command and records the caller identity; identical resolution retries are idempotent.

Effective blockages are unresolved records targeting the work or any `parent-of` ancestor, across arbitrary intermediary nodes and domains. A task blockage leaves siblings available. A parent blockage affects its descendants. Resolving one record never resolves another, changes assignment, bypasses graph prerequisites or advances a workflow machine.

Summary shape: `{id, domain, target, reason}`. Detail additionally supplies `raisedBy`, `neededFrom`, `raisedAt` and `resolution`; identities use `{identity, nodeIds}`. Resolution is null or `{text, by, at}`. Origin targets and domains identify the command responsible for resolution.

Operational blockage is distinct from dependency readiness and authored control flow. No synthetic `depends-on` edge or XState state is introduced. Domain mutations enforce effective holds; graph readiness itself is unchanged. Kanban's blocked lane is presentation, not another source of blocking authority.
