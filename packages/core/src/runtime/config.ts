import { resolve, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

import { z } from "zod";

import type { Spool } from "./context.ts";

const configSchema = z.strictObject({
  name: z
    .string()
    .regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/u)
    .optional(),
  spools: z.array(z.string().min(1)).default([]),
});
export const workspaceSchema = z.looseObject({ botlake: configSchema });
export type WorkspaceConfig = z.infer<typeof configSchema>;
export async function loadWorkspace(
  path: string,
): Promise<{ config: WorkspaceConfig; spools: Spool[] }> {
  const { botlake: config } = workspaceSchema.parse(
    await Bun.file(resolve(path, ".botlake/package.json")).json(),
  );
  const spools: Spool[] = [];
  for (const specifier of config.spools) {
    const location =
      isAbsolute(specifier) || specifier.startsWith(".")
        ? resolve(path, specifier)
        : Bun.resolveSync(specifier, resolve(path, ".botlake"));
    const module: unknown = await import(pathToFileURL(location).href);
    const parsed = z
      .object({
        default: z.object({
          name: z.string(),
          requires: z.array(z.string()).optional(),
          activate: z.custom<Spool["activate"]>((value) => typeof value === "function"),
        }),
      })
      .parse(module);
    spools.push({ ...parsed.default, requires: parsed.default.requires ?? [] });
  }
  return { config, spools };
}
export function configJsonSchema(): unknown {
  return z.toJSONSchema(workspaceSchema, { io: "input" });
}
