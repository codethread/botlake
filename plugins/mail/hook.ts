import { z } from "zod";

import {
  mailInstruction,
  MailTimeout,
  openMailbox,
  pollMail,
  reportDelivery,
  traceMail,
  waitMail,
  type Mailbox,
} from "./client.ts";

// Claude and Codex share this hook wire protocol; the provider argument selects the identity.
const provider = z.enum(["codex", "claude"]).parse(Bun.argv[2]);
const session = { session_id: z.string().min(1), cwd: z.string().min(1) };
const hookInput = z.discriminatedUnion("hook_event_name", [
  z.object({
    hook_event_name: z.enum(["SessionStart", "PostToolUse", "PostToolUseFailure"]),
    ...session,
    agent_id: z.string().optional(),
  }),
  // Private events from the Claude idle mod (claude.ts): find unannounced mail without recording
  // delivery, holding the request open when asked, then record the handoff once the woken turn
  // has started.
  z.object({ hook_event_name: z.literal("IdleMail"), ...session, hold: z.boolean() }),
  z.object({
    hook_event_name: z.literal("IdleMailDelivered"),
    ...session,
    ids: z.array(z.string()),
  }),
]);

let written = false;
let event: string | undefined;
try {
  const input = hookInput.parse(await Bun.stdin.json());
  event = input.hook_event_name;
  // Native subagents share the caller's session; only the root session owns the mailbox.
  const box =
    "agent_id" in input && input.agent_id !== undefined
      ? null
      : await openMailbox({ provider, nativeSessionId: input.session_id }, input.cwd, process.env);
  if (input.hook_event_name === "IdleMail") await idleMail(box, input.hold);
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
  }
} catch (error) {
  const systemMessage = `Botlake mail hook failed: ${String(error)}`;
  process.stderr.write(`${systemMessage}\n`);
  if (!written) await output(busy(error) ?? { systemMessage });
}

// A busy lake is not an outage: the idle mod retries, and tool results look again on the next
// tool. Startup still reports it, because the identity instruction went unsaid.
function busy(error: unknown): object | undefined {
  if (!(error instanceof MailTimeout) || event === "SessionStart") return undefined;
  return event === "IdleMail" || event === "IdleMailDelivered" ? { busy: true } : {};
}

// `inactive` tells the mod to stop: no lake, or a lake that does not select Mail.
async function idleMail(box: Mailbox | null, hold: boolean): Promise<void> {
  const started = performance.now();
  const poll = box === null ? null : await (hold ? waitMail(box) : pollMail(box));
  if (box !== null && poll !== null)
    await traceMail(box, {
      event: "idle-wait",
      provider,
      hold,
      ids: poll.ids,
      durationMs: performance.now() - started,
    });
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
