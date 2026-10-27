import { appendFile } from "node:fs/promises";

import { identityInstruction } from "@botlake/native-session";
import { z } from "zod";

import { sessionEnvironment } from "../session.ts";
import { contextOutput, type HookAdapter } from "./contract.ts";
import { events, hookEventSchema } from "./events.ts";

export const claude: HookAdapter = {
  provider: "claude",
  decode(raw) {
    const event = hookEventSchema.parse(raw);
    const child =
      event.hook_event_name === "SubagentStart" || event.hook_event_name === "SubagentStop";
    const nativeSessionId = child
      ? `claude-child:${Buffer.from(JSON.stringify([event.session_id, z.string().min(1).parse(event.agent_id)])).toString("base64url")}`
      : event.session_id;
    return {
      nativeEvent: event.hook_event_name,
      context:
        event.hook_event_name === "SessionStart" || event.hook_event_name === "SubagentStart",
      unmanaged: child || event.source === "clear",
      observation: {
        provider: "claude",
        nativeSessionId,
        cwd: event.cwd,
        event: events[event.hook_event_name],
        nativeEvent: event.hook_event_name,
        ...(child ? { parentNativeSessionId: event.session_id } : {}),
        ...(event.model === undefined ? {} : { model: event.model }),
        ...(event.transcript_path === undefined
          ? {}
          : { sessionPath: child ? (event.agent_transcript_path ?? null) : event.transcript_path }),
        capabilities: ["activity", "model", "session-end", "parent"],
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
    // Hosts without CLAUDE_ENV_FILE still get identity context; child hooks never rewrite parent env.
    return contextOutput(event, report);
  },
};
