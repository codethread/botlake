import { sessionIdentity } from "@botlake/native-session";
import { z } from "zod";

import {
  inboxReader,
  loadMailConfig,
  mailInstruction,
  pollMail,
  reportDelivery,
  traceMail,
} from "./client.ts";

const hookInput = z.object({
  hook_event_name: z.enum(["SessionStart", "PostToolUse"]),
  session_id: z.string().min(1),
  agent_id: z.string().optional(),
});
await main();

async function main(): Promise<void> {
  let written = false;
  try {
    const input = hookInput.parse(await Bun.stdin.json());
    if (input.agent_id !== undefined) {
      await output({});
      return;
    }
    const config = loadMailConfig(process.env);
    const identity = sessionIdentity({ provider: "codex", nativeSessionId: input.session_id });
    if (input.hook_event_name === "SessionStart") {
      await traceMail(config, { event: "session-start", identity, sessionId: input.session_id });
      await output({
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: mailInstruction(config, identity),
        },
      });
      return;
    }
    const started = performance.now();
    const result = await pollMail(config, identity, inboxReader(config, identity, process.env));
    await traceMail(config, {
      event: "tool-result",
      identity,
      notice: result.notice,
      durationMs: performance.now() - started,
    });
    await output(
      result.notice === ""
        ? {}
        : {
            hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: result.notice },
          },
    );
    written = true;
    if (result.ids.length > 0) await reportDelivery(config, identity, result.ids, process.env);
  } catch (error) {
    const systemMessage = `Botlake mail hook failed: ${String(error)}`;
    process.stderr.write(`${systemMessage}\n`);
    if (!written) await output({ systemMessage });
  }
}

function output(value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(`${JSON.stringify(value)}\n`, (error) => {
      if (error === undefined || error === null) resolve();
      else reject(error);
    });
  });
}
