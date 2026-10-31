import { contextOutput, type HookAdapter } from "./contract.ts";
import { hookObservation } from "./events.ts";

export const codex: HookAdapter = {
  provider: "codex",
  decode(event) {
    return {
      nativeEvent: event.hook_event_name,
      context: event.hook_event_name === "SessionStart",
      unmanaged: event.source === "clear" || event.source === "fork",
      observation: {
        provider: "codex",
        nativeSessionId: event.session_id,
        ...hookObservation(event),
      },
    };
  },
  async deliver(event, report) {
    // Codex hooks cannot export identity into later tool shells; context is the native transport.
    return contextOutput(event, report);
  },
};
