import { z } from "zod";

/** Mutable flag record; its read-only form is stored as JSON in flag_overrides.flag. */
export const flagSchema = z.compile(
  z.strictObject({ description: z.string().trim().min(1), value: z.boolean() }),
);

/** Flag record parsed from the flag_overrides.flag JSON column. */
export const storedFlagSchema = z.compile(flagSchema.readonly());

export type Flag = z.infer<typeof storedFlagSchema>;
