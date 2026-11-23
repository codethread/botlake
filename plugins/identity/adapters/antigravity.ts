import {
  activityExcerpt,
  identityInstruction,
  sessionIdentity,
  type NativeObservation,
} from "@botlake/native-session";
import { z } from "zod";

import type { reportNative } from "../session.ts";

const common = z.object({
  conversationId: z.string().min(1),
  workspacePaths: z.array(z.string().min(1)),
  transcriptPath: z.string().min(1).optional(),
  modelName: z.string().min(1).optional(),
});
const invocation = z.object({
  invocationNum: z.int().nonnegative(),
  lastUserInput: z.string().optional(),
});
const tool = z.object({
  stepIdx: z.int().nonnegative(),
  toolCall: z.object({ name: z.string().min(1), args: z.record(z.string(), z.unknown()) }),
  error: z.string().optional(),
});
const stop = z.object({ fullyIdle: z.boolean() });
const events = z.enum(["SessionStart", "PreInvocation", "PreToolUse", "PostToolUse", "Stop"]);

/** Antigravity doesn't send the event name on stdin; each hooks.json command supplies it. */
export async function antigravityHook(
  name: string | undefined,
  payload: unknown,
  env: NodeJS.ProcessEnv,
  report: typeof reportNative,
): Promise<unknown> {
  const nativeEvent = events.parse(name);
  const { conversationId, workspacePaths, transcriptPath, modelName } = common.parse(payload);
  const session = { provider: "antigravity", nativeSessionId: conversationId };
  // The hook cwd is the installed plugin, not the conversation workspace.
  const cwd = workspacePaths[0];
  if (cwd === undefined) {
    return nativeEvent === "SessionStart"
      ? startupContext(identityInstruction(sessionIdentity(session)))
      : antigravityPassThrough(nativeEvent);
  }

  const observation: NativeObservation = {
    ...session,
    cwd,
    nativeEvent,
    capabilities: ["activity", "model", "tools", "messages"],
    ...(transcriptPath === undefined ? {} : { sessionPath: transcriptPath }),
    ...(modelName === undefined ? {} : { model: modelName }),
    ...activity(nativeEvent, payload),
  };
  const result = await report(observation, env);
  return nativeEvent === "SessionStart"
    ? startupContext([result.instruction, result.systemPrompt].filter(Boolean).join("\n\n"))
    : antigravityPassThrough(nativeEvent);
}

/** Observation never grants tool permission, blocks execution or starts another invocation. */
export function antigravityPassThrough(event: string | undefined): unknown {
  if (event === "PreToolUse") return { decision: "allow" };
  if (event === "Stop") return { decision: "stop" };
  return {};
}

// -- Private helpers --

function startupContext(text: string) {
  return { injectSteps: [{ systemMessage: { systemMessage: text } }] };
}

function activity(
  name: z.infer<typeof events>,
  payload: unknown,
): Pick<NativeObservation, "event" | "activity"> {
  switch (name) {
    case "SessionStart":
      return { event: "session-start" };
    case "PreInvocation": {
      const { invocationNum, lastUserInput } = invocation.parse(payload);
      // Later model calls in the loop repeat the last user input, not a new user turn.
      if (invocationNum !== 0) return { event: "metadata" };
      return {
        event: "agent-start",
        activity:
          lastUserInput === undefined
            ? []
            : [{ kind: "message", role: "user", turnId: null, ...activityExcerpt(lastUserInput) }],
      };
    }
    case "PreToolUse":
    case "PostToolUse": {
      const { stepIdx, toolCall, error } = tool.parse(payload);
      const detail = {
        turnId: null,
        callId: String(stepIdx),
        tool: toolCall.name,
        ...activityExcerpt(JSON.stringify(toolCall.args)),
      };
      return {
        event: "metadata",
        activity:
          name === "PreToolUse"
            ? [{ kind: "tool-started", ...detail }]
            : [
                {
                  kind: "tool-ended",
                  ...detail,
                  outcome: error === undefined || error === "" ? "completed" : "failed",
                },
              ],
      };
    }
    case "Stop":
      return { event: stop.parse(payload).fullyIdle ? "agent-end" : "metadata" };
  }
}
