import { z } from "zod";

import { mailInstruction, openMailbox, pollMail, reportDelivery, traceMail } from "./client.ts";

// Claude and Codex share this hook wire protocol; the provider argument selects the identity.
const provider = z.enum(["codex", "claude"]).parse(Bun.argv[2]);
const hookInput = z.object({
  hook_event_name: z.enum(["SessionStart", "PostToolUse", "PostToolUseFailure"]),
  session_id: z.string().min(1),
  cwd: z.string().min(1),
  agent_id: z.string().optional(),
});

let written = false;
try {
  const input = hookInput.parse(await Bun.stdin.json());
  // Native subagents share the caller's session; only the root session owns the mailbox.
  const box =
    input.agent_id === undefined
      ? await openMailbox({ provider, nativeSessionId: input.session_id }, input.cwd, process.env)
      : null;
  const started = performance.now();
  const poll = box === null ? null : await pollMail(box);
  if (box === null || poll === null) await output({});
  else {
    const startup = input.hook_event_name === "SessionStart";
    const context = [startup ? mailInstruction(box) : "", poll.notice]
      .filter((part) => part.length > 0)
      .join("\n\n");
    await traceMail(box, {
      event: startup ? "session-start" : "tool-result",
      nativeEvent: input.hook_event_name,
      provider,
      sessionId: input.session_id,
      notice: poll.notice,
      durationMs: performance.now() - started,
    });
    await output(
      context === ""
        ? {}
        : {
            hookSpecificOutput: {
              hookEventName: input.hook_event_name,
              additionalContext: context,
            },
          },
    );
    written = true;
    // Record the handoff only after the host has the notice; a failed report leaves mail eligible.
    if (poll.ids.length > 0) await reportDelivery(box, poll.ids);
  }
} catch (error) {
  const systemMessage = `Botlake mail hook failed: ${String(error)}`;
  process.stderr.write(`${systemMessage}\n`);
  if (!written) await output({ systemMessage });
}

function output(value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(`${JSON.stringify(value)}\n`, (error) => {
      if (error === undefined || error === null) resolve();
      else reject(error);
    });
  });
}
