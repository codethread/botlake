import { sessionIdentity } from "@botlake/native-session";

import {
  inboxReader,
  loadMailConfig,
  mailInstruction,
  pollMail,
  reportDelivery,
  traceMail,
  type MailConfig,
} from "./client.ts";

interface PiContext {
  sessionManager: {
    getSessionId(): string;
  };
}

interface ToolContent {
  type: string;
  text?: string;
  [key: string]: unknown;
}

interface PiEvents {
  before_agent_start: { systemPrompt: string };
  session_start: unknown;
  tool_result: { content: ToolContent[] };
}

interface PiResults {
  before_agent_start: { systemPrompt: string };
  session_start: void;
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

interface SessionMailState {
  identity: string;
  queue: Promise<unknown>;
  sessionId: string;
}

export default function mailExtension(pi: PiApi): void {
  const config = loadMailConfig(process.env);
  let state: SessionMailState | undefined;

  pi.on("session_start", async (_, ctx) => {
    state = createSessionState(ctx);
    await traceMail(config, {
      event: "session-start",
      provider: "pi",
      identity: state.identity,
      sessionId: state.sessionId,
    });
  });

  pi.on("before_agent_start", (event, ctx) => {
    const identity = identityFor(ctx);
    return {
      systemPrompt: `${event.systemPrompt}\n\n${mailInstruction(config, identity)}`,
    };
  });

  pi.on("tool_result", (event, ctx) => {
    const session = stateFor(ctx, state);
    const operation = session.queue.then(
      () => appendMailNotice(config, session, event.content),
      () => appendMailNotice(config, session, event.content),
    );
    session.queue = operation.catch(() => null);
    return operation;
  });
}

function createSessionState(ctx: PiContext): SessionMailState {
  const sessionId = ctx.sessionManager.getSessionId();
  return {
    identity: sessionIdentity({ provider: "pi", nativeSessionId: sessionId }),
    queue: Promise.resolve(),
    sessionId,
  };
}

function identityFor(ctx: PiContext): string {
  const sessionId = ctx.sessionManager.getSessionId();
  return sessionIdentity({ provider: "pi", nativeSessionId: sessionId });
}

function stateFor(ctx: PiContext, state: SessionMailState | undefined): SessionMailState {
  const sessionId = ctx.sessionManager.getSessionId();
  if (state === undefined || state.sessionId !== sessionId) {
    throw new Error(`Mail session state is unavailable for Pi session ${sessionId}`);
  }
  return state;
}

async function appendMailNotice(
  mailConfig: MailConfig,
  state: SessionMailState,
  content: ToolContent[],
): Promise<{ content: ToolContent[] }> {
  const startedAt = performance.now();
  let notice = "";
  try {
    const result = await pollMail(
      mailConfig,
      state.identity,
      inboxReader(mailConfig, state.identity, process.env),
    );
    notice = result.notice;
    if (result.ids.length > 0)
      await reportDelivery(mailConfig, state.identity, result.ids, process.env);
  } catch (error) {
    notice = [notice, `Mail unavailable: ${errorMessage(error)}`]
      .filter((part) => part.length > 0)
      .join("\n");
  }

  await traceMail(mailConfig, {
    event: "tool-result",
    identity: state.identity,
    notice,
    durationMs: performance.now() - startedAt,
  });

  if (notice.length === 0) return { content };
  return { content: [...content, { type: "text", text: notice }] };
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return Array.from(message).slice(0, 200).join("");
}
