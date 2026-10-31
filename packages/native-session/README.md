# @botlake/native-session

Shared native-session protocol for Botlake adapters and extensions. No runtime activation or database dependency.

`sessionIdentity({ provider, nativeSessionId })` derives a stable three-word attribution name (for example, `calm-brave-otter`) using `unique-names-generator`. The provider/session pair remains authoritative; registration rejects name collisions rather than merging sessions. The generator version is pinned to keep names stable. `observationSchema` describes lifecycle and optional metadata; `registrationSchema` adds optional managed run/invocation correlation.

Activity is the last reported observation, not liveness, process ownership or completion. Missing metadata and unsupported events remain unknown.

`runActivityDetailSchema` describes bounded tool/message observations and scoped harness-reported usage. `activityExcerpt()` caps searchable text at 2,048 characters and marks truncation. Adapters retain native session/transcript references rather than translating complete transcripts. `runUsageSchema` preserves unknown values as null and does not estimate prices or combine reports.
