import { setTimeout as delay } from "node:timers/promises";

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

// The pause between waits, and the first step of the backoff after a failed one.
const RETRY_MS = 5000;
const MAX_RETRY_MS = 60_000;
// A lake restart or a busy machine costs a wait or two; only a lasting failure is worth a notice.
const WARN_AFTER = 3;

interface PiContext {
  mode: "tui" | "rpc" | "print" | "json";
  isIdle(): boolean;
  ui: { notify(text: string, level: "warning"): void };
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
  session_shutdown: unknown;
  before_agent_start: {
    systemPrompt: string;
    systemPromptOptions?: { sections: Record<string, string> };
  };
  tool_result: { content: ToolContent[] };
}

interface PiResults {
  session_start: void;
  session_shutdown: void;
  before_agent_start: { systemPrompt: string };
  tool_result: { content: ToolContent[] };
}

interface PiApi {
  sendMessage(
    message: { customType: string; content: string; display: boolean },
    options: { triggerTurn: true },
  ): void;
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

  let lifetime: AbortController | undefined;
  const stop = () => {
    lifetime?.abort();
    session = undefined;
  };
  pi.on("session_shutdown", stop);
  pi.on("session_start", async (_, ctx) => {
    stop();
    lifetime = new AbortController();
    const { signal } = lifetime;
    const sessionId = ctx.sessionManager.getSessionId();
    const box = await openMailbox(
      { provider: "pi", nativeSessionId: sessionId },
      ctx.cwd,
      process.env,
    );
    if (box === null || !(await selectsMail(box)) || signal.aborted) return;
    session = { sessionId, box, queue: Promise.resolve() };
    if (ctx.mode === "tui") void watchIdleMail(pi, ctx, session, signal);
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
    return serialize(current, () => appendMailNotice(current.box, event.content));
  });
}

async function watchIdleMail(
  pi: PiApi,
  ctx: PiContext,
  current: Session,
  signal: AbortSignal,
): Promise<void> {
  let misses = 0;
  // If recording delivery failed, retry the receipt without starting another paid turn.
  let handedOff: string[] = [];
  const handOff = async () => {
    const poll = await pollMail(current.box);
    // The human may have submitted a prompt or switched sessions since the wait answered.
    if (signal.aborted || !ctx.isIdle() || poll === null || poll.ids.length === 0) return;
    if (poll.ids.some((id) => !handedOff.includes(id))) {
      pi.sendMessage(
        { customType: "botlake-mail", content: poll.notice, display: true },
        { triggerTurn: true },
      );
      handedOff = poll.ids;
      await traceMail(current.box, { event: "idle-nudge", provider: "pi", ids: poll.ids });
    }
    await reportDelivery(current.box, poll.ids);
    handedOff = [];
  };
  while (!signal.aborted) {
    try {
      await delay(Math.min(RETRY_MS * 2 ** misses, MAX_RETRY_MS), undefined, {
        signal,
        ref: false,
      });
      // A wait already held when a turn starts simply ends unused; none begins during a turn.
      if (!ctx.isIdle()) continue;
      // Held outside the lane, so tool results never queue behind it.
      const waited = await waitMail(current.box, signal);
      if (waited !== null && waited.ids.length > 0) await serialize(current, handOff);
      misses = 0;
    } catch (error) {
      if (signal.aborted) return;
      misses += 1;
      if (misses === WARN_AFTER)
        ctx.ui.notify(`Mail unavailable: ${errorMessage(error)}`, "warning");
    }
  }
}

// The idle watcher's handoff and tool results share a lane from poll through receipt.
function serialize<T>(session: Session, operation: () => Promise<T>): Promise<T> {
  const result = session.queue.then(operation);
  session.queue = result.catch(() => null);
  return result;
}

// Probe without reporting delivery. Keep an unavailable mailbox so later checks can recover.
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
    // A busy lake is not an outage; the mail stays eligible for the next tool result.
    if (!(error instanceof MailTimeout))
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
