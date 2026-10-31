import { z } from "zod";

export const workAgentAttributes = {
  /** Marks the private connection between one Work assignment and one agent run. */
  binding: "work-agents/binding",
  /** Serialized binding evidence; Work remains the assignment source of truth. */
  value: "work-agents/value",
} as const;

const text = z.string().trim().min(1);
export const workAgentBindingSchema = z.compile(
  z.strictObject({
    task: text,
    assignment: text,
    run: text,
    invocation: text.nullable(),
    identity: text,
    heartbeatAt: z.number().int(),
    status: z.enum(["active", "released", "superseded"]),
  }),
);
