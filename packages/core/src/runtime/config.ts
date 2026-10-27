import { resolve, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

import { z } from "zod";

import type { Extension } from "./context.ts";

const configSchema = z.strictObject({
  name: z
    .string()
    .regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/u)
    .optional(),
  extensions: z.array(z.string().min(1)).default([]),
});

export const workspaceSchema = z.looseObject({ botlake: configSchema });

export type WorkspaceConfig = z.infer<typeof configSchema>;

export async function loadWorkspace(
  path: string,
): Promise<{ config: WorkspaceConfig; extensions: Extension[] }> {
  const { botlake: config } = workspaceSchema.parse(
    await Bun.file(resolve(path, ".botlake/package.json")).json(),
  );
  const extensions: Extension[] = [];

  for (const specifier of config.extensions) {
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
          activate: z.custom<Extension["activate"]>((value) => typeof value === "function"),
        }),
      })
      .parse(module);
    extensions.push({ ...parsed.default, requires: parsed.default.requires ?? [] });
  }
  return { config, extensions };
}

export function configJsonSchema(): unknown {
  return z.toJSONSchema(workspaceSchema, { io: "input" });
}
