# @botlake/native-session

Shared native-session protocol for Botlake adapters and extensions. No runtime activation or database dependency.

`sessionIdentity({ provider, nativeSessionId })` derives a stable three-word attribution name (for example, `calm-brave-otter`) using `unique-names-generator`. The provider/session pair remains authoritative; registration rejects name collisions rather than merging sessions. The generator version is pinned to keep names stable. `observationSchema` describes lifecycle and optional metadata; `registrationSchema` adds optional managed run/invocation correlation.

Activity is the last reported observation, not liveness, process ownership or completion. Missing metadata and unsupported events remain unknown.
