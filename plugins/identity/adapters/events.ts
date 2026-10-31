import {
  activityExcerpt,
  type NativeEvent,
  type NativeObservation,
  type RunActivityDetail,
} from "@botlake/native-session";
import { z } from "zod";

const text = z.compile(z.string().min(1));

export const hookEventSchema = z.compile(
  z.object({
    hook_event_name: z.enum([
      "SessionStart",
      "UserPromptSubmit",
      "Stop",
      "SessionEnd",
      "PreToolUse",
      "PostToolUse",
      "PostToolUseFailure",
    ]),
    session_id: z.string().min(1),
    cwd: z.string().min(1),
    source: z.string().optional(),
    agent_id: text.optional(),
    model: z.string().min(1).optional(),
    transcript_path: z.string().nullable().optional(),
    turn_id: z.string().optional(),
    prompt_id: z.string().optional(),
    tool_name: z.string().optional(),
    tool_use_id: z.string().optional(),
    tool_input: z.unknown().optional(),
    is_interrupt: z.boolean().optional(),
    prompt: z.string().optional(),
    last_assistant_message: z.string().nullable().optional(),
  }),
);

const events: Record<z.infer<typeof hookEventSchema>["hook_event_name"], NativeEvent> = {
  SessionStart: "session-start",
  UserPromptSubmit: "agent-start",
  Stop: "agent-end",
  SessionEnd: "session-end",
  PreToolUse: "metadata",
  PostToolUse: "metadata",
  PostToolUseFailure: "metadata",
};

const commandSchema = z.compile(z.object({ command: z.string() }));
export type NativeHookInput = z.infer<typeof hookEventSchema>;

/** Shared hook observations; each adapter retains its host's identity and delivery rules. */
export function hookObservation(
  event: NativeHookInput,
): Omit<NativeObservation, "provider" | "nativeSessionId"> {
  const turnId = event.turn_id ?? event.prompt_id;
  return {
    cwd: event.cwd,
    event: events[event.hook_event_name],
    nativeEvent: event.hook_event_name,
    ...(event.model === undefined ? {} : { model: event.model }),
    ...(event.transcript_path === undefined ? {} : { sessionPath: event.transcript_path }),
    capabilities: ["activity", "tools", "messages", "model", "session-end"],
    activity: hookActivity(event, turnId ?? null),
    ...(turnId === undefined ? {} : { turnId }),
  };
}

function hookActivity(
  event: z.infer<typeof hookEventSchema>,
  turnId: string | null,
): RunActivityDetail[] {
  switch (event.hook_event_name) {
    case "PreToolUse":
    case "PostToolUse":
    case "PostToolUseFailure": {
      const common = {
        turnId,
        callId: text.parse(event.tool_use_id),
        tool: text.parse(event.tool_name),
        ...toolExcerpt(event.tool_input),
      };
      return event.hook_event_name === "PreToolUse"
        ? [{ kind: "tool-started", ...common }]
        : [
            {
              kind: "tool-ended",
              ...common,
              outcome:
                event.hook_event_name === "PostToolUseFailure"
                  ? event.is_interrupt === true
                    ? "cancelled"
                    : "failed"
                  : "completed",
            },
          ];
    }
    case "UserPromptSubmit":
      return event.prompt === undefined
        ? []
        : [{ kind: "message", role: "user", turnId, ...activityExcerpt(event.prompt) }];
    case "Stop":
      return typeof event.last_assistant_message !== "string"
        ? []
        : [
            {
              kind: "message",
              role: "assistant",
              turnId,
              ...activityExcerpt(event.last_assistant_message),
            },
          ];
    case "SessionStart":
    case "SessionEnd":
      return [];
  }
}

export function toolExcerpt(input: unknown): { summary: string; truncated: boolean } {
  const command = commandSchema.safeParse(input);
  return activityExcerpt(command.success ? command.data.command : (JSON.stringify(input) ?? ""));
}
