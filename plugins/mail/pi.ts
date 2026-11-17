import {
  mailInstruction,
  openMailbox,
  pollMail,
  reportDelivery,
  traceMail,
  type Mailbox,
} from "./client.ts";

interface PiContext {
  cwd: string;
  sessionManager: { getSessionId(): string };
}

interface ToolContent {
  type: string;
  text?: string;
  [key: string]: unknown;
}

interface PiEvents {
  session_start: unknown;
  before_agent_start: {
    systemPrompt: string;
    systemPromptOptions?: { sections: Record<string, string> };
  };
  tool_result: { content: ToolContent[] };
}

interface PiResults {
  session_start: void;
  before_agent_start: { systemPrompt: string };
  tool_result: { content: ToolContent[] };
}

interface PiApi {
  on<K extends keyof PiEvents>(
    event: K,
    handler: (
      event: PiEvents[K],
      ctx: PiContext,
    ) => Promise<PiResults[K] | void> | PiResults[K] | void,
  ): void;
}

interface Session {
  sessionId: string;
  box: Mailbox;
  queue: Promise<unknown>;
}

export default function mailExtension(pi: PiApi): void {
  if (process.env["PI_SUBAGENT"] === "1" || process.env["PI_SUBAGENT_CHILD"] === "1") return;
  // Absent outside a lake, or when the lake does not select Mail.
  let session: Session | undefined;

  pi.on("session_start", async (_, ctx) => {
    session = undefined;
    const sessionId = ctx.sessionManager.getSessionId();
    const box = await openMailbox(
      { provider: "pi", nativeSessionId: sessionId },
      ctx.cwd,
      process.env,
    );
    if (box === null || !(await selectsMail(box))) return;
    session = { sessionId, box, queue: Promise.resolve() };
    await traceMail(box, { event: "session-start", provider: "pi", sessionId });
  });

  pi.on("before_agent_start", (event, ctx) => {
    const current = currentSession(session, ctx);
    if (current === undefined) return;
    const instruction = mailInstruction(current.box);
    if (event.systemPromptOptions !== undefined) {
      event.systemPromptOptions.sections["botlake-mail"] = instruction;
      return;
    }
    return { systemPrompt: `${event.systemPrompt}\n\n${instruction}` };
  });

  pi.on("tool_result", (event, ctx) => {
    const current = currentSession(session, ctx);
    if (current === undefined) return;
    // Serialize polls so overlapping tool results do not announce the same batch twice.
    const operation = current.queue.then(
      () => appendMailNotice(current.box, event.content),
      () => appendMailNotice(current.box, event.content),
    );
    current.queue = operation.catch(() => null);
    return operation;
  });
}

// Probe without reporting delivery; the first tool result announces pending mail. An unavailable
// lake keeps the mailbox so tool results surface the failure instead of silently dropping mail.
async function selectsMail(box: Mailbox): Promise<boolean> {
  try {
    return (await pollMail(box)) !== null;
  } catch {
    return true;
  }
}

function currentSession(session: Session | undefined, ctx: PiContext): Session | undefined {
  return session?.sessionId === ctx.sessionManager.getSessionId() ? session : undefined;
}

async function appendMailNotice(
  box: Mailbox,
  content: ToolContent[],
): Promise<{ content: ToolContent[] }> {
  const startedAt = performance.now();
  let notice = "";
  try {
    const poll = await pollMail(box);
    notice = poll?.notice ?? "";
    if (poll !== null && poll.ids.length > 0) await reportDelivery(box, poll.ids);
  } catch (error) {
    notice = [notice, `Mail unavailable: ${errorMessage(error)}`]
      .filter((part) => part.length > 0)
      .join("\n");
  }
  await traceMail(box, {
    event: "tool-result",
    provider: "pi",
    notice,
    durationMs: performance.now() - startedAt,
  });
  return notice.length === 0
    ? { content }
    : { content: [...content, { type: "text", text: notice }] };
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return Array.from(message).slice(0, 200).join("");
}
