import { basename, dirname, join, resolve, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { z } from "zod";

import type { Extension } from "./context.ts";
import { coreVersion, requireCoreVersion, semanticVersionSchema } from "./version.ts";

const extensionModuleSchema = z.compile(
  z.object({
    default: z.object({
      name: z.string(),
      source: z.url({ protocol: /^file$/u }).optional(),
      requires: z.array(z.string()).optional(),
      activate: z.custom<Extension["activate"]>((value) => typeof value === "function"),
    }),
  }),
);

const configSchema = z.compile(
  z.strictObject({
    name: z
      .string()
      .regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/u)
      .optional(),
    extensions: z.array(z.string().min(1)).default([]),
    minimumCore: semanticVersionSchema.optional(),
  }),
);

const packageMetadataSchema = z.compile(z.object({ description: z.string().optional() }));

export const workspaceSchema = z.compile(z.looseObject({ botlake: configSchema }));

export const extensionInfoSchema = z.compile(
  z.object({
    name: z.string(),
    description: z.string().nullable(),
    specifier: z.string(),
    module: z.string(),
    source: z.string(),
    packageJson: z.string().nullable(),
    readme: z.string().nullable(),
  }),
);

export const workspaceInfoSchema = z.compile(
  z.object({
    path: z.string(),
    name: z.string(),
    packageJson: z.string(),
    coreVersion: semanticVersionSchema,
    minimumCore: semanticVersionSchema.nullable(),
    extensions: z.array(extensionInfoSchema),
  }),
);

export type WorkspaceConfig = z.infer<typeof configSchema>;
export type ExtensionInfo = z.infer<typeof extensionInfoSchema>;
export type WorkspaceInfo = z.infer<typeof workspaceInfoSchema>;

export async function loadWorkspace(
  path: string,
): Promise<{ config: WorkspaceConfig; extensions: Extension[]; info: WorkspaceInfo }> {
  const workspace = resolve(path);
  const packageJson = join(workspace, ".botlake/package.json");
  const { botlake: config } = workspaceSchema.parse(await Bun.file(packageJson).json());
  requireCoreVersion(config.minimumCore);
  const extensions: Extension[] = [];
  const info: WorkspaceInfo = {
    path: workspace,
    name: config.name ?? basename(workspace),
    packageJson,
    coreVersion,
    minimumCore: config.minimumCore ?? null,
    extensions: [],
  };

  for (const specifier of config.extensions) {
    const location =
      isAbsolute(specifier) || specifier.startsWith(".")
        ? resolve(workspace, specifier)
        : Bun.resolveSync(specifier, join(workspace, ".botlake"));
    const module: unknown = await import(pathToFileURL(location).href);
    const parsed = extensionModuleSchema.parse(module);
    const extension = { ...parsed.default, requires: parsed.default.requires ?? [] };
    extensions.push(extension);
    const source = extension.source === undefined ? location : fileURLToPath(extension.source);
    info.extensions.push({
      name: extension.name,
      specifier,
      module: location,
      source,
      ...(await sourcePackage(source)),
    });
  }
  return { config, extensions, info };
}

export function configJsonSchema(): unknown {
  return z.toJSONSchema(workspaceSchema, { io: "input" });
}

// -- Private helpers --

async function sourcePackage(
  source: string,
): Promise<Pick<ExtensionInfo, "packageJson" | "readme" | "description">> {
  let directory = dirname(source);
  while (true) {
    const packageJson = join(directory, "package.json");
    if (await Bun.file(packageJson).exists()) {
      const metadata = packageMetadataSchema.parse(await Bun.file(packageJson).json());
      const readme = join(directory, "README.md");
      return {
        packageJson,
        readme: (await Bun.file(readme).exists()) ? readme : null,
        description: metadata.description ?? null,
      };
    }
    const parent = dirname(directory);
    if (parent === directory) return { packageJson: null, readme: null, description: null };
    directory = parent;
  }
}
