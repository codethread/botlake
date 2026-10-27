# @botlake/native-session

Shared native-session protocol for Botlake adapters and extensions. No runtime activation or database dependency.

`sessionIdentity({ provider, nativeSessionId })` derives the same SHA-256 attribution key wherever a native session is observed. The provider/session pair remains the canonical lookup key. `observationSchema` describes lifecycle and optional metadata; `registrationSchema` adds optional managed run/invocation correlation.

Activity is the last reported observation, not liveness, process ownership or completion. Missing metadata and unsupported events remain unknown.
