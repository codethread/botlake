import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

import {
  identityInstruction,
  sessionIdentity,
  type NativeEvent,
  type NativeObservation,
} from "@botlake/native-session";
import { z } from "zod";

import { reportNative, sessionEnvironment, type SessionReport } from "./session.ts";

interface PiContext {
  cwd: string;
  sessionManager: {
    getSessionId(): string;
    getSessionFile?(): string | undefined;
    getHeader?(): { parentSession?: string } | null;
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
  let managedSession = process.env["BL_NATIVE_SESSION_ID"];
  let parentNativeSessionId: string | undefined;
  function observation(ctx: PiContext, event: NativeEvent): NativeObservation {
    return {
      provider: "pi",
      nativeSessionId: ctx.sessionManager.getSessionId(),
      cwd: ctx.cwd,
      event,
      ...(process.env["PI_SUBAGENT"] === "1" ? { audience: "agent" as const } : {}),
      model:
        ctx.model === undefined
          ? null
          : ctx.model.provider === undefined
            ? ctx.model.id
            : `${ctx.model.provider}/${ctx.model.id}`,
      thinkingLevel: ctx.thinkingLevel ?? null,
      sessionPath: ctx.sessionManager.getSessionFile?.() ?? null,
      ...(parentNativeSessionId === undefined ? {} : { parentNativeSessionId }),
      capabilities: ["activity", "model", "effort", "session-end", "parent"],
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
  ): Promise<SessionReport> {
    const input = observation(ctx, event);
    const child = process.env["PI_SUBAGENT"] === "1";
    if (managedSession === undefined && process.env["BL_RUN_REFERENCE"] !== undefined && !child)
      managedSession = input.nativeSessionId;
    local(ctx);
    const result = await reportNative(
      { ...input, nativeEvent },
      process.env,
      child || (managedSession !== undefined && managedSession !== input.nativeSessionId),
    );
    if (ctx.hasUI === true)
      ctx.ui?.setStatus(
        "botlake-tracking",
        result.tracking === "unavailable" ? "Botlake tracking unavailable" : undefined,
      );
    return result;
  }
  pi.on("session_start", async (_, ctx) => {
    parentNativeSessionId =
      process.env["PI_SUBAGENT"] === "1" && process.env["BL_NATIVE_PROVIDER"] === "pi"
        ? managedSession
        : undefined;
    const parent = ctx.sessionManager.getHeader?.()?.parentSession;
    if (parent !== undefined) {
      try {
        parentNativeSessionId = await parentSession(parent);
      } catch (error) {
        process.stderr.write(`Botlake parent attribution unavailable: ${String(error)}\n`);
      }
    }
    await report(ctx, "session-start", "session_start");
  });
  pi.on("agent_start", async (_, ctx) => {
    await report(ctx, "agent-start", "agent_start");
  });
  pi.on("agent_end", async (_, ctx) => {
    await report(ctx, "agent-end", "agent_end");
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

// -- Private helpers --

async function parentSession(path: string): Promise<string> {
  const stream = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input: stream });
  try {
    for await (const line of lines) {
      return z.object({ type: z.literal("session"), id: z.string().min(1) }).parse(JSON.parse(line))
        .id;
    }
    throw new Error("Native parent session has no header");
  } finally {
    lines.close();
    stream.destroy();
  }
}
