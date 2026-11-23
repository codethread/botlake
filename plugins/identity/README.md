# @botlake/identity

Native adapters for Antigravity CLI, Codex, Pi and Claude, sharing `@botlake/native-session` identity/protocol and `@botlake/identity/session` reporting. This is the client plugin, not the `@botlake/extension-identity` server extension.

This harness-only package is private and is not part of the npm runtime release. Install `botlake-identity` like [Mail](../mail/README.md); Pi uses `out/plugins/botlake-identity`. Hooks require Bun, `botlake` and `bl` on `PATH`; `BL_BIN` overrides `bl`. Nothing installs into user profiles automatically.

For tracking, the target workspace must select Identity and Agents (and Flags when using gated seats). Discovery uses the Git common root's `.botlake/package.json`, or explicit `BL_WORKSPACE`. Before reporting, adapters check `botlake lake status` and attempt `botlake lake start` if unavailable. The supervisor must already be running. Startup failures retain local identity and report tracking unavailability. Managed launches supply an invocation reference, never a fresh session ID. Direct native sessions register without process custody.

| Adapter | Identity delivery | Observations when supported by the host |
| --- | --- | --- |
| Antigravity CLI | Session context; no shell-env export | Start, first model invocation and user text, tools, idle stop and model |
| Pi | Prompt section (full-prompt fallback), shell env | Start/end, turns, tools, visible messages, reported usage, model/effort |
| Codex | Session context; no hook shell-env export | Start/end, prompt/stop, tools, available user/final assistant text and model |
| Claude | Session context; optional `CLAUDE_ENV_FILE` | Start/end, prompt/stop, tools, available user/final assistant text and model |

Pi and Claude shell injection sets `BL_ACTOR` to the native identity and supplies `BL_AGENT_SEAT`, `BL_MODEL` and `BL_EFFORT` when known. Pi refreshes these on metadata changes and does not modify the status line; use `BL_ACTOR` in your own status-line configuration to display the identity. Antigravity, Codex and Claude hosts without `CLAUDE_ENV_FILE` receive guidance to invoke `bl --identity IDENTITY OP`; operation-specific `--by`, assignee and subject flags retain their separate meanings.

Agents' `unmanaged.systemPrompt` supplies project context for direct sessions: Pi refreshes it before each turn, Antigravity/Claude/Codex at session startup. Managed runs receive their configured prompt through launch arguments instead; adapters do not add the unmanaged prompt. Project context requires a reachable lake; local identity still works when tracking is unavailable.

Missing metadata stays unknown; capabilities describe adapter support, not proof that a host emitted every event. Activity is the last observation, not liveness or task completion.

Antigravity CLI support follows Google's [hook contract](https://antigravity.google/docs/hooks/) and has been tested with example payloads, not a live `agy` session. Identity is keyed by `antigravity` and `conversationId`. The first mounted `workspacePaths` entry supplies the working directory; with no mounts, only local identity is available. `PreInvocation` with `invocationNum: 0` is treated as the start of a turn; subsequent model calls do not repeat the user message. A fully idle `Stop` ends a turn, **not** a session. There is no documented session-close hook, usage report or child marker. This plugin does not add a managed launch/resume provider.

Pi, Claude and Codex ignore identified child callbacks. Antigravity reports by conversation ID without inferring parentage. No adapter reads child transcripts.

Adapters report compact [run activity](../../extensions/agents/README.md#run-activity), including native session/transcript references. A turn is the outer prompt-to-stop/agent-end cycle; internal model iterations are not separately tracked. Messages and tool inputs become bounded excerpts; full transcripts, tool results and reasoning stay with the harness. Pi reports usage as supplied on completed assistant messages; hooks without usage fields leave it unknown.

Database unavailability retains deterministic local identity and reports a tracking warning on stderr; it does not block native work. Without executed hooks, Botlake cannot inject context or observe unmanaged sessions. Managed output can still establish identity, labeled `agent/integration: output`. GUI support depends on that specific host executing the integration; installation alone proves nothing.
