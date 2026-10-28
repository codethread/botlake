import type { NativeEvent } from "@botlake/native-session";
import { z } from "zod";

export const agentIdSchema = z.compile(z.string().min(1));

export const hookEventSchema = z.compile(
  z.object({
    hook_event_name: z.enum([
      "SessionStart",
      "UserPromptSubmit",
      "Stop",
      "SessionEnd",
      "SubagentStart",
      "SubagentStop",
    ]),
    session_id: z.string().min(1),
    cwd: z.string().min(1),
    source: z.string().optional(),
    agent_id: agentIdSchema.optional(),
    model: z.string().min(1).optional(),
    transcript_path: z.string().nullable().optional(),
    agent_transcript_path: z.string().nullable().optional(),
  }),
);

export const events: Record<z.infer<typeof hookEventSchema>["hook_event_name"], NativeEvent> = {
  SessionStart: "session-start",
  UserPromptSubmit: "agent-start",
  Stop: "agent-end",
  SessionEnd: "session-end",
  SubagentStart: "session-start",
  SubagentStop: "agent-end",
};
