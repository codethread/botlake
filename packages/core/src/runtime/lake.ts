import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { z } from "zod";

import type { WorkspaceInfo } from "./config.ts";
import type { Extension } from "./context.ts";
import { coreVersion, lakeWireVersion } from "./version.ts";

export interface LakeDefinition {
  readonly name?: string;
  readonly extensions: readonly Extension[];
}

export interface LakeConfig {
  readonly name: string;
  readonly extensions: Extension[];
}

const definitionSchema = z.compile(
  z.strictObject({
    name: z
      .string()
      .regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/u)
      .optional(),
    extensions: z.array(
      z.object({
        name: z.string(),
        source: z.url({ protocol: /^file$/u }).optional(),
        requires: z.array(z.string()).optional(),
        activate: z.custom<Extension["activate"]>((value) => typeof value === "function"),
      }),
    ),
  }),
);

export function createLake(definition: LakeDefinition): LakeDefinition {
  return Object.freeze({ ...definition, extensions: Object.freeze([...definition.extensions]) });
}

export async function loadLakeConfig(workspace: string): Promise<{
  config: LakeConfig;
  info: WorkspaceInfo;
}> {
  const root = resolve(workspace);
  const configPath = join(root, ".botlake/lake.ts");
  const module: unknown = await import(
    `${pathToFileURL(configPath).href}?generation=${crypto.randomUUID()}`
  );
  const parsedModule = z.object({ lake: z.unknown() }).parse(module);
  const definition = definitionSchema.parse(parsedModule.lake);
  const packageJson = join(root, ".botlake/package.json");
  const extensions = definition.extensions.map((extension) => ({
    ...extension,
    requires: extension.requires ?? [],
  }));
  const info: WorkspaceInfo = {
    path: root,
    name: definition.name ?? basename(root),
    configPath,
    packageJson,
    coreVersion,
    lakeWireVersion,
    extensions: [],
  };

  for (const extension of extensions) {
    const source = extension.source === undefined ? null : fileURLToPath(extension.source);
    info.extensions.push({
      name: extension.name,
      description: source === null ? null : (await sourcePackage(source)).description,
      specifier: null,
      module: null,
      source,
      packageJson: source === null ? null : (await sourcePackage(source)).packageJson,
      readme: source === null ? null : (await sourcePackage(source)).readme,
    });
  }

  return {
    config: {
      name: info.name,
      extensions,
    },
    info,
  };
}

async function sourcePackage(source: string): Promise<{
  packageJson: string | null;
  readme: string | null;
  description: string | null;
}> {
  let directory = dirname(source);
  while (true) {
    const packageJson = join(directory, "package.json");
    if (await Bun.file(packageJson).exists()) {
      const metadata = z
        .object({ description: z.string().optional() })
        .parse(await Bun.file(packageJson).json());
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
