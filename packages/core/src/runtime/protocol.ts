import { z } from "zod";

export const invocationSchema = z
  .strictObject({
    workspace: z.string(),
    request_id: z.string().min(1),
    name: z.string().min(1),
    input: z.unknown().optional(),
    argv: z.array(z.string()).optional(),
    payloads: z.record(z.string().min(1), z.string()).optional(),
    cwd: z.string().optional(),
    worktree_root: z.string().optional(),
    git_common_dir: z.string().optional(),
    is_tty: z.boolean().optional(),
    tty_col: z.number().int().positive().nullable().optional(),
    timeout_ms: z.number().positive().optional(),
  })
  .refine((value) => value.argv === undefined || !Object.hasOwn(value, "input"), {
    message: "Choose argv or input, not both",
  });

export const workerMessageSchema = z.union([
  invocationSchema,
  z.strictObject({ cancel: z.string() }),
]);
