import { resolve, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

import { z } from "zod";

import { batteries } from "../spools/batteries.ts";
import { harnesses, harnessConfigSchema } from "../spools/harnesses/harnesses.ts";
import { identity } from "../spools/identity.ts";
import { kanban } from "../spools/kanban.ts";
import type { Spool } from "./runtime.ts";

export const workspaceSchema = z.strictObject({
  name: z
    .string()
    .regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/u)
    .optional(),
  spools: z.array(z.string().min(1)).default(["batteries"]),
  harnesses: harnessConfigSchema.optional(),
});
export type WorkspaceConfig = z.infer<typeof workspaceSchema>;
export async function loadWorkspace(
  path: string,
): Promise<{ config: WorkspaceConfig; spools: Spool[] }> {
  const config = workspaceSchema.parse(
    await Bun.file(resolve(path, ".millstrand/config.json")).json(),
  );
  const spools: Spool[] = [];
  for (const specifier of config.spools) {
    if (specifier === "batteries") {
      spools.push(batteries());
      continue;
    }
    if (specifier === "identity") {
      spools.push(identity());
      continue;
    }
    if (specifier === "kanban") {
      spools.push(kanban());
      continue;
    }
    if (specifier === "harnesses") {
      spools.push(harnesses(config.harnesses));
      continue;
    }
    const location =
      isAbsolute(specifier) || specifier.startsWith(".")
        ? resolve(path, specifier)
        : Bun.resolveSync(specifier, path);
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
  return z.toJSONSchema(workspaceSchema);
}
