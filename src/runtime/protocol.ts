import { z } from "zod";
export const invocationSchema = z.strictObject({
  workspace: z.string(),
  request_id: z.string().min(1),
  name: z.string().min(1),
  input: z.unknown().optional(),
  argv: z.array(z.string()).optional(),
  timeout_ms: z.number().positive().optional(),
  bin: z.boolean().optional(),
});
export const workerMessageSchema = z.union([
  invocationSchema,
  z.strictObject({ cancel: z.string() }),
]);
