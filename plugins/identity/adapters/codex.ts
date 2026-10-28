import { z } from "zod";

import { contextOutput, type HookAdapter } from "./contract.ts";
import { events, hookEventSchema } from "./events.ts";

export const codex: HookAdapter = {
  provider: "codex",
  decode(raw) {
    const event = hookEventSchema.parse(raw);
    const child =
      event.agent_id !== undefined ||
      event.hook_event_name === "SubagentStart" ||
      event.hook_event_name === "SubagentStop";
    return {
      nativeEvent: event.hook_event_name,
      context:
        event.hook_event_name === "SessionStart" || event.hook_event_name === "SubagentStart",
      unmanaged: child || event.source === "clear" || event.source === "fork",
      observation: {
        provider: "codex",
        // Codex's agent_id is the child's actual native thread id.
        nativeSessionId: child ? z.string().min(1).parse(event.agent_id) : event.session_id,
        cwd: event.cwd,
        event: events[event.hook_event_name],
        nativeEvent: event.hook_event_name,
        ...(child ? { parentNativeSessionId: event.session_id, audience: "agent" as const } : {}),
        ...(event.model === undefined ? {} : { model: event.model }),
        ...(event.transcript_path === undefined
          ? {}
          : { sessionPath: child ? (event.agent_transcript_path ?? null) : event.transcript_path }),
        capabilities: ["activity", "model", "session-end", "parent"],
      },
    };
  },
  async deliver(event, report) {
    // Codex hooks cannot export identity into later tool shells; context is the native transport.
    return contextOutput(event, report);
  },
};
