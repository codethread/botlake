import { z } from "zod";

import {
  mailInstruction,
  openMailbox,
  pollMail,
  reportDelivery,
  traceMail,
  type Mailbox,
} from "./client.ts";

const provider = z.enum(["codex", "claude", "antigravity"]).parse(Bun.argv[2]);
const agySession = z.object({
  conversationId: z.string().min(1),
  workspacePaths: z.array(z.string().min(1)),
});
const agyEvent = z.enum(["SessionStart", "PreInvocation"]);

// Claude and Codex share this hook wire protocol.
const session = { session_id: z.string().min(1), cwd: z.string().min(1) };
const hookInput = z.discriminatedUnion("hook_event_name", [
  z.object({
    hook_event_name: z.enum(["SessionStart", "PostToolUse", "PostToolUseFailure"]),
    ...session,
    agent_id: z.string().optional(),
  }),
  // Private events from the Claude idle mod (claude.ts): poll without recording delivery, then
  // record the handoff once the woken turn has started.
  z.object({ hook_event_name: z.literal("IdleMail"), ...session }),
  z.object({
    hook_event_name: z.literal("IdleMailDelivered"),
    ...session,
    ids: z.array(z.string()),
  }),
]);

let written = false;
try {
  const payload: unknown = await Bun.stdin.json();
  const input =
    provider === "antigravity" ? antigravityInput(payload, Bun.argv[3]) : hookInput.parse(payload);
  // Identified Claude/Codex child hooks share the caller's session but not its mailbox.
  const box =
    input.cwd === undefined || ("agent_id" in input && input.agent_id !== undefined)
      ? null
      : await openMailbox({ provider, nativeSessionId: input.session_id }, input.cwd, process.env);
  if (input.hook_event_name === "IdleMail") await idlePoll(box);
  else if (input.hook_event_name === "IdleMailDelivered") {
    if (box !== null) {
      await reportDelivery(box, input.ids);
      await traceMail(box, { event: "idle-nudge", provider, ids: input.ids });
    }
    await output({});
  } else {
    const started = performance.now();
    const poll = box === null ? null : await pollMail(box);
    if (box === null || poll === null) await output({});
    else {
      const startup = input.hook_event_name === "SessionStart";
      const context = [startup ? mailInstruction(box) : "", poll.notice]
        .filter((part) => part.length > 0)
        .join("\n\n");
      await traceMail(box, {
        event: startup
          ? "session-start"
          : input.hook_event_name === "PreInvocation"
            ? "pre-invocation"
            : "tool-result",
        nativeEvent: input.hook_event_name,
        provider,
        sessionId: input.session_id,
        notice: poll.notice,
        durationMs: performance.now() - started,
      });
      await output(
        context === ""
          ? {}
          : provider === "antigravity"
            ? { injectSteps: [{ ephemeralMessage: context }] }
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
  }
} catch (error) {
  const systemMessage = `Botlake mail hook failed: ${String(error)}`;
  process.stderr.write(`${systemMessage}\n`);
  if (!written) await output(provider === "antigravity" ? {} : { systemMessage });
}

function antigravityInput(payload: unknown, name: string | undefined) {
  const { conversationId, workspacePaths } = agySession.parse(payload);
  return {
    hook_event_name: agyEvent.parse(name),
    session_id: conversationId,
    cwd: workspacePaths[0],
  };
}

// `inactive` tells the mod to stop polling: no lake, or a lake that does not select Mail.
async function idlePoll(box: Mailbox | null): Promise<void> {
  const poll = box === null ? null : await pollMail(box);
  await output(poll === null ? { inactive: true } : { ids: poll.ids, notice: poll.notice });
}

function output(value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(`${JSON.stringify(value)}\n`, (error) => {
      if (error === undefined || error === null) resolve();
      else reject(error);
    });
  });
}
