# @botlake/identity

Native adapters for Codex, Pi and Claude, sharing `@botlake/native-session` identity/protocol and `@botlake/identity/session` reporting. This is the client plugin, not the `@botlake/extension-identity` server extension.

Install explicitly in each native host. Pi uses `pi.extensions` or `@botlake/identity/pi`; Codex and Claude use the included plugin manifests. Keep package dependencies resolvable when copying a plugin. Hooks require Bun and `bl` on `PATH`; `BOTLAKE_BL_BIN` overrides the latter. Nothing installs into user profiles automatically.

The target workspace must select Identity, Flags and Harnesses. Discovery uses the Git common root's `.botlake/package.json`, or explicit `BOTLAKE_WORKSPACE`. Managed launches supply an invocation reference, never a fresh session ID. Direct native sessions register without process custody.

| Adapter | Identity delivery | Observations when supported by the host |
| --- | --- | --- |
| Pi | Prompt section (full-prompt fallback), shell env, status | Start/end, agent activity, model/effort changes, native fork ancestry |
| Codex | Session/child context; no hook shell-env export | Start/end, prompt/stop activity, supplied model, native child thread IDs |
| Claude | Session/child context; optional `CLAUDE_ENV_FILE` | Start/end, prompt/stop activity, supplied model, parent-scoped child IDs |

Claude child keys are scoped attribution, not independently resumable sessions. Missing metadata stays unknown; capabilities describe adapter support, not proof that a host emitted every event. Activity is the last observation, not liveness or task completion.

Database unavailability retains deterministic local identity and displays a tracking warning; it does not block native work. Without executed hooks, Botlake cannot inject context or observe unmanaged sessions. Managed output can still establish identity, labeled `harness/integration: output`. GUI support depends on that specific host executing the integration; installation alone proves nothing.
