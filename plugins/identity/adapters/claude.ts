import { appendFile } from "node:fs/promises";

import { identityInstruction } from "@botlake/native-session";

import { sessionEnvironment } from "../session.ts";
import { contextOutput, type HookAdapter } from "./contract.ts";
import { hookObservation } from "./events.ts";

export const claude: HookAdapter = {
  provider: "claude",
  decode(event) {
    return {
      nativeEvent: event.hook_event_name,
      context: event.hook_event_name === "SessionStart",
      unmanaged: event.source === "clear",
      observation: {
        provider: "claude",
        nativeSessionId: event.session_id,
        ...hookObservation(event),
      },
    };
  },
  async deliver(event, report, env) {
    const path = env["CLAUDE_ENV_FILE"];
    if (event.nativeEvent === "SessionStart" && path !== undefined) {
      const exports = Object.entries(sessionEnvironment(event.observation, env)).map(
        ([key, value]) =>
          value === undefined
            ? `unset ${key}`
            : `export ${key}='${value.replaceAll("'", "'\\''")}'`,
      );
      try {
        await appendFile(path, `${exports.join("\n")}\n`);
        return contextOutput(event, {
          ...report,
          instruction: identityInstruction(report.identity, true),
        });
      } catch (error) {
        const message = `Botlake shell identity unavailable: ${String(error)}`;
        process.stderr.write(`${message}\n`);
        return contextOutput(event, { ...report, error: message });
      }
    }
    // Hosts without CLAUDE_ENV_FILE still get identity context.
    return contextOutput(event, report);
  },
};
