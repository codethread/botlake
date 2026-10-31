# @botlake/identity

Native adapters for Codex, Pi and Claude, sharing `@botlake/native-session` identity/protocol and `@botlake/identity/session` reporting. This is the client plugin, not the `@botlake/extension-identity` server extension.

Install explicitly in each native host. Pi uses `pi.extensions` or `@botlake/identity/pi`; Codex and Claude use the included plugin manifests. Keep package dependencies resolvable when copying a plugin. Hooks require Bun, `botlake` and `bl` on `PATH`; `BL_BIN` overrides `bl`. Nothing installs into user profiles automatically.

The target workspace must select Identity, Flags and Agents. Discovery uses the Git common root's `.botlake/package.json`, or explicit `BL_WORKSPACE`. Before reporting, adapters check `botlake lake status` and attempt `botlake lake start` if unavailable. The supervisor must already be running. Startup failures retain local identity and report tracking unavailability. Managed launches supply an invocation reference, never a fresh session ID. Direct native sessions register without process custody.

| Adapter | Identity delivery | Observations when supported by the host |
| --- | --- | --- |
| Pi | Prompt section (full-prompt fallback), shell env, status | Start/end, turns, tools, visible messages, reported usage, model/effort |
| Codex | Session context; no hook shell-env export | Start/end, prompt/stop, tools, available user/final assistant text and model |
| Claude | Session context; optional `CLAUDE_ENV_FILE` | Start/end, prompt/stop, tools, available user/final assistant text and model |

Pi and Claude shell injection sets `BL_ACTOR` to the native identity and supplies `BL_AGENT_SEAT`, `BL_MODEL` and `BL_EFFORT` when known. Pi refreshes these on metadata changes. Codex and Claude hosts without `CLAUDE_ENV_FILE` receive explicit `--by-identity`/`--owner` guidance instead.

Agents' `unmanaged.systemPrompt` supplies project context for direct sessions: Pi refreshes it before each turn, Claude/Codex at session startup. Managed runs receive their configured prompt through launch arguments instead; adapters do not add the unmanaged prompt. Project context requires a reachable lake; local identity still works when tracking is unavailable.

Missing metadata stays unknown; capabilities describe adapter support, not proof that a host emitted every event. Activity is the last observation, not liveness or task completion.

Native subagents appear only as tool calls in the caller's activity. Identified child callbacks are ignored; these adapters do not register child sessions or inspect their transcripts.

Adapters report compact [run activity](../../extensions/agents/README.md#run-activity), including native session/transcript references. A turn is the outer prompt-to-stop/agent-end cycle; internal model iterations are not separately tracked. Messages and tool inputs become bounded excerpts; full transcripts, tool results and reasoning stay with the harness. Pi reports usage as supplied on completed assistant messages; hooks without usage fields leave it unknown.

Database unavailability retains deterministic local identity and displays a tracking warning; it does not block native work. Without executed hooks, Botlake cannot inject context or observe unmanaged sessions. Managed output can still establish identity, labeled `agent/integration: output`. GUI support depends on that specific host executing the integration; installation alone proves nothing.
