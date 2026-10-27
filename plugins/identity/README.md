# @botlake/identity

Native adapters for Codex, Pi and Claude, sharing `@botlake/native-session` identity/protocol and `@botlake/identity/session` reporting. This is the client plugin, not the `@botlake/extension-identity` server extension.

Install explicitly in each native host. Pi uses `pi.extensions` or `@botlake/identity/pi`; Codex and Claude use the included plugin manifests. Keep package dependencies resolvable when copying a plugin. Hooks require Bun and `bl` on `PATH`; `BL_BIN` overrides the latter. Nothing installs into user profiles automatically.

The target workspace must select Identity, Flags and Agents. Discovery uses the Git common root's `.botlake/package.json`, or explicit `BL_WORKSPACE`. Managed launches supply an invocation reference, never a fresh session ID. Direct native sessions register without process custody.

| Adapter | Identity delivery | Observations when supported by the host |
| --- | --- | --- |
| Pi | Prompt section (full-prompt fallback), shell env, status | Start/end, agent activity, model/effort changes, native fork ancestry |
| Codex | Session/child context; no hook shell-env export | Start/end, prompt/stop activity, supplied model, native child thread IDs |
| Claude | Session/child context; optional `CLAUDE_ENV_FILE` | Start/end, prompt/stop activity, supplied model, parent-scoped child IDs |

Pi and Claude shell injection sets `BL_ACTOR` to the native identity and supplies `BL_AGENT_SEAT`, `BL_MODEL` and `BL_EFFORT` when known. Pi refreshes these on metadata changes. Codex, Claude child hooks and Claude hosts without `CLAUDE_ENV_FILE` receive explicit `--by-identity`/`--owner` guidance instead. Child sessions do not borrow parent metadata.

Agents' `unmanaged.systemPrompt` supplies project context for direct sessions: Pi refreshes it before each turn, Claude/Codex at session/child startup. Managed runs receive their configured prompt through launch arguments instead; adapters do not add the unmanaged prompt. Project context requires a reachable lake; local identity still works when tracking is unavailable.

Claude child keys are scoped attribution, not independently resumable sessions. Missing metadata stays unknown; capabilities describe adapter support, not proof that a host emitted every event. Activity is the last observation, not liveness or task completion.

Database unavailability retains deterministic local identity and displays a tracking warning; it does not block native work. Without executed hooks, Botlake cannot inject context or observe unmanaged sessions. Managed output can still establish identity, labeled `agent/integration: output`. GUI support depends on that specific host executing the integration; installation alone proves nothing.
