import {
  identityInstruction,
  activityExcerpt,
  sessionIdentity,
  type NativeEvent,
  type NativeObservation,
  type RunActivityDetail,
} from "@botlake/native-session";
import { z } from "zod";

import { toolExcerpt } from "./adapters/events.ts";
import { reportNative, sessionEnvironment, type SessionReport } from "./session.ts";

const messageSchema = z.compile(
  z.object({
    role: z.enum(["user", "assistant"]),
    content: z.union([
      z.string(),
      z.array(z.object({ type: z.string(), text: z.string().optional() })),
    ]),
    usage: z.unknown().optional(),
  }),
);
const tokens = z.number().int().nonnegative().optional();
const usageSchema = z.compile(
  z.object({
    input: tokens,
    output: tokens,
    cacheRead: tokens,
    cacheWrite: tokens,
    totalTokens: tokens,
    cost: z.object({ total: z.number().nonnegative() }).optional(),
  }),
);

interface PiContext {
  cwd: string;
  sessionManager: {
    getSessionId(): string;
    getSessionFile?(): string | undefined;
  };
  model?: { id: string; provider?: string };
  thinkingLevel?: string;
  hasUI?: boolean;
  ui?: { setStatus(key: string, value: string | undefined): void };
}
interface PiEvents {
  session_start: { reason?: string };
  session_shutdown: { reason?: string };
  agent_start: unknown;
  agent_end: unknown;
  model_select: unknown;
  thinking_level_select: unknown;
  before_agent_start: {
    systemPrompt: string;
    systemPromptOptions?: { sections: Record<string, string> };
  };
  tool_execution_start: { toolCallId: string; toolName: string; args: unknown };
  tool_execution_end: { toolCallId: string; toolName: string; isError: boolean };
  message_end: { message: unknown };
}
interface PiApi {
  on<K extends keyof PiEvents>(
    event: K,
    handler: (
      event: PiEvents[K],
      ctx: PiContext,
    ) => Promise<void | { systemPrompt: string }> | void | { systemPrompt: string },
  ): void;
}

export default function identityExtension(pi: PiApi): void {
  if (process.env["PI_SUBAGENT"] === "1" || process.env["PI_SUBAGENT_CHILD"] === "1") return;
  let managedSession = process.env["BL_NATIVE_SESSION_ID"];
  let turnId: string | undefined;
  function observation(ctx: PiContext, event: NativeEvent): NativeObservation {
    return {
      provider: "pi",
      nativeSessionId: ctx.sessionManager.getSessionId(),
      cwd: ctx.cwd,
      event,
      model:
        ctx.model === undefined
          ? null
          : ctx.model.provider === undefined
            ? ctx.model.id
            : `${ctx.model.provider}/${ctx.model.id}`,
      thinkingLevel: ctx.thinkingLevel ?? null,
      sessionPath: ctx.sessionManager.getSessionFile?.() ?? null,
      capabilities: ["activity", "tools", "messages", "usage", "model", "effort", "session-end"],
      ...(turnId === undefined ? {} : { turnId }),
    };
  }
  function local(ctx: PiContext): void {
    const input = observation(ctx, "metadata");
    for (const [key, value] of Object.entries(sessionEnvironment(input, process.env))) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    const identity = sessionIdentity(input);
    if (ctx.hasUI === true) ctx.ui?.setStatus("botlake-identity", identity);
  }
  async function report(
    ctx: PiContext,
    event: NativeEvent,
    nativeEvent: string,
    activity: NativeObservation["activity"] = [],
  ): Promise<SessionReport> {
    const input = observation(ctx, event);
    if (managedSession === undefined && process.env["BL_RUN_REFERENCE"] !== undefined)
      managedSession = input.nativeSessionId;
    local(ctx);
    const result = await reportNative(
      { ...input, nativeEvent, activity },
      process.env,
      managedSession !== undefined && managedSession !== input.nativeSessionId,
    );
    if (ctx.hasUI === true)
      ctx.ui?.setStatus(
        "botlake-tracking",
        result.tracking === "unavailable" ? "Botlake tracking unavailable" : undefined,
      );
    return result;
  }
  pi.on("session_start", async (_, ctx) => {
    await report(ctx, "session-start", "session_start");
  });
  pi.on("agent_start", async (_, ctx) => {
    turnId = crypto.randomUUID();
    await report(ctx, "agent-start", "agent_start");
  });
  pi.on("agent_end", async (_, ctx) => {
    await report(ctx, "agent-end", "agent_end");
    turnId = undefined;
  });
  pi.on("tool_execution_start", async (event, ctx) => {
    await report(ctx, "metadata", "tool_execution_start", [
      {
        kind: "tool-started",
        turnId: turnId ?? null,
        callId: event.toolCallId,
        tool: event.toolName,
        ...toolExcerpt(event.args),
      },
    ]);
  });
  pi.on("tool_execution_end", async (event, ctx) => {
    await report(ctx, "metadata", "tool_execution_end", [
      {
        kind: "tool-ended",
        turnId: turnId ?? null,
        callId: event.toolCallId,
        tool: event.toolName,
        summary: "",
        truncated: false,
        outcome: event.isError ? "failed" : "completed",
      },
    ]);
  });
  pi.on("message_end", async (event, ctx) => {
    const message = messageSchema.safeParse(event.message);
    if (!message.success) return;
    const content = message.data.content;
    const text =
      typeof content === "string"
        ? content
        : content
            .filter((part) => part.type === "text")
            .map((part) => part.text ?? "")
            .join("\n");
    const details: RunActivityDetail[] =
      text.length === 0
        ? []
        : [
            {
              kind: "message",
              role: message.data.role,
              turnId: turnId ?? null,
              ...activityExcerpt(text),
            },
          ];
    const usage = usageSchema.safeParse(message.data.usage);
    if (message.data.role === "assistant" && usage.success)
      details.push({
        kind: "usage",
        turnId: turnId ?? null,
        usage: {
          scope: "message",
          inputTokens: usage.data.input ?? null,
          outputTokens: usage.data.output ?? null,
          cacheReadTokens: usage.data.cacheRead ?? null,
          cacheWriteTokens: usage.data.cacheWrite ?? null,
          totalTokens: usage.data.totalTokens ?? null,
          cost:
            usage.data.cost === undefined
              ? null
              : { amount: usage.data.cost.total, currency: "USD" },
        },
      });
    if (details.length > 0) await report(ctx, "metadata", "message_end", details);
  });
  pi.on("model_select", async (_, ctx) => {
    await report(ctx, "metadata", "model_select");
  });
  pi.on("thinking_level_select", async (_, ctx) => {
    await report(ctx, "metadata", "thinking_level_select");
  });
  pi.on("session_shutdown", async (_, ctx) => {
    await report(ctx, "session-end", "session_shutdown");
    if (ctx.hasUI === true) {
      ctx.ui?.setStatus("botlake-identity", undefined);
      ctx.ui?.setStatus("botlake-tracking", undefined);
    }
  });
  pi.on("before_agent_start", async (event, ctx) => {
    const result = await report(ctx, "metadata", "before_agent_start");
    const instruction = [identityInstruction(result.identity, true), result.systemPrompt]
      .filter((part) => part.length > 0)
      .join("\n\n");
    if (event.systemPromptOptions !== undefined) {
      event.systemPromptOptions.sections["botlake"] = instruction;
      return;
    }
    return { systemPrompt: `${event.systemPrompt}\n\n${instruction}` };
  });
}
