import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { Fault } from "@botlake/core";
import { z } from "zod";

import { definitionSchema, type Definition } from "./definition.ts";

const FIRST = 0;
const NONEMPTY = 1;
const dependencyFiles = new Set([
  "package.json",
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);
const text = z.string().min(NONEMPTY);
const semanticVersion =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const nameSchema = z.compile(z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u));
const manifestSchema = z.compile(
  z.strictObject({
    description: z.string().trim().min(NONEMPTY),
    run: z
      .string()
      .min(NONEMPTY)
      .regex(/\.(?:js|ts)$/u),
    version: z.string().trim().regex(semanticVersion, "Expected a full semantic version"),
  }),
);

export const locatorSchema = z.compile(
  z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("named"),
      name: text,
      version: z.string().trim().regex(semanticVersion, "Expected a full semantic version"),
      hash: text,
    }),
    z.strictObject({ kind: z.literal("file"), source: text, hash: text }),
  ]),
);

export type Selection = { kind: "named"; name: string } | { kind: "file"; source: string };
export type Locator = z.infer<typeof locatorSchema>;
export interface LoadedDefinition {
  definition: Definition;
  locator: Locator;
  source: string;
}
export interface Catalogue {
  list(): Promise<Array<{ name: string; version: string; description: string; source: string }>>;
  load(selection: Selection): Promise<LoadedDefinition>;
  restore(locator: Locator): Promise<LoadedDefinition>;
}

export interface WorkflowFileIO {
  readDirectory(
    path: string,
  ): Promise<Array<{ kind: "directory" | "file" | "other"; name: string }>>;
  readText(path: string): Promise<string>;
  readBytes(path: string): Promise<ArrayBuffer>;
  isFile(path: string): Promise<boolean>;
  importModule(path: string, entryHash: string, namedProvenance?: string): Promise<unknown>;
}

export function workflowCatalogue(workspace: string, files: WorkflowFileIO): Catalogue {
  const root = resolve(workspace);

  return {
    async list() {
      const directory = join(root, ".workflows");
      const entries = await optionalDirectory(directory, files);
      const names = entries
        .filter((entry) => entry.kind === "directory" && entry.name !== "node_modules")
        .map((entry) => entry.name)
        .toSorted();
      return Promise.all(
        names.map(async (name) => {
          const selected = await namedSource(root, name, files);
          return {
            name: selected.name,
            version: selected.version,
            description: selected.description,
            source: selected.source,
          };
        }),
      );
    },

    async load(selection) {
      if (selection.kind === "named") {
        const selected = await namedSource(root, selection.name, files);
        const [hash, entryHash] = await Promise.all([
          fingerprintFolder(selected.directory, files),
          fingerprintFile(selected.source, files),
        ]);
        return importLoaded(
          selected.source,
          { kind: "named", name: selected.name, version: selected.version, hash },
          entryHash,
          hash,
        );
      }
      const source = resolve(root, selection.source);
      const hash = await fingerprintFile(source, files);
      return importLoaded(source, { kind: "file", source, hash }, hash);
    },

    async restore(locator) {
      const parsed = locatorSchema.parse(locator);
      if (parsed.kind === "named") {
        const selected = await namedSource(root, parsed.name, files);
        if (selected.version !== parsed.version)
          throw changed(
            selected.source,
            `Expected named workflow ${parsed.name} version ${parsed.version}, found ${selected.version}`,
          );
        const [hash, entryHash] = await Promise.all([
          fingerprintFolder(selected.directory, files),
          fingerprintFile(selected.source, files),
        ]);
        assertFingerprint(selected.source, hash, parsed.hash);
        return importLoaded(selected.source, parsed, entryHash, hash);
      }
      const source = resolve(root, parsed.source);
      const hash = await fingerprintFile(source, files);
      assertFingerprint(source, hash, parsed.hash);
      return importLoaded(source, { ...parsed, source }, hash);
    },
  };

  async function importLoaded(
    source: string,
    locator: Locator,
    entryHash: string,
    namedProvenance?: string,
  ): Promise<LoadedDefinition> {
    const definition = definitionSchema.parse(
      await files.importModule(source, entryHash, namedProvenance),
    );
    return { definition, locator, source };
  }
}

// -- Private helpers --

async function namedSource(workspace: string, name: string, files: WorkflowFileIO) {
  const parsedName = nameSchema.parse(name);
  const directory = join(workspace, ".workflows", parsedName);
  try {
    await files.readDirectory(directory);
  } catch (error) {
    if (isMissing(error))
      throw new Fault(
        "workflow-missing",
        `Named workflow ${parsedName} is missing from ${workspace}`,
      );
    throw error;
  }
  const manifest = manifestSchema.parse(
    Bun.TOML.parse(await files.readText(join(directory, "workflow.toml"))),
  );
  const source = resolve(directory, manifest.run);
  if (isAbsolute(manifest.run) || relative(directory, source).split(sep)[FIRST] === "..")
    throw new Fault(
      "workflow-manifest",
      `Workflow ${parsedName} run must be relative and stay inside its definition folder`,
    );
  if (!(await files.isFile(source)))
    throw new Fault("workflow-manifest", `Workflow ${parsedName} entry is not a file: ${source}`);
  return { directory, name: parsedName, source, ...manifest };
}

async function fingerprintFile(source: string, files: WorkflowFileIO): Promise<string> {
  if (!(await files.isFile(source)))
    throw new Fault(
      "workflow-missing",
      `Workflow definition is not a file: ${source}. List workspace definitions with bl workflow catalog`,
    );
  const hash = new Bun.CryptoHasher("sha256");
  return hash.update(await files.readBytes(source)).digest("hex");
}

async function fingerprintFolder(directory: string, files: WorkflowFileIO): Promise<string> {
  const paths = await provenanceFiles(directory, files);
  const hash = new Bun.CryptoHasher("sha256");
  for (const path of paths.toSorted()) {
    const content = await files.readBytes(path);
    hash.update(JSON.stringify([relative(directory, path), content.byteLength]));
    hash.update(content);
  }
  return hash.digest("hex");
}

async function provenanceFiles(directory: string, files: WorkflowFileIO): Promise<string[]> {
  const local = await definitionFiles(directory, files);
  const parent = resolve(directory, "..");
  const siblings = await files.readDirectory(parent);
  return [
    ...local,
    ...siblings
      .filter((entry) => entry.kind === "file" && dependencyFiles.has(entry.name))
      .map((entry) => join(parent, entry.name)),
  ];
}

async function definitionFiles(directory: string, files: WorkflowFileIO): Promise<string[]> {
  const paths: string[] = [];
  const entries = await files.readDirectory(directory);
  for (const entry of entries.filter(({ name }) => name !== "node_modules")) {
    const path = join(directory, entry.name);
    if (entry.kind === "directory") paths.push(...(await definitionFiles(path, files)));
    else if (entry.kind === "file") paths.push(path);
    else
      throw new Fault(
        "workflow-entry",
        `Definition files must be regular files or directories: ${path}`,
      );
  }
  return paths;
}

async function optionalDirectory(
  path: string,
  files: WorkflowFileIO,
): Promise<Array<{ kind: "directory" | "file" | "other"; name: string }>> {
  try {
    return await files.readDirectory(path);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

function assertFingerprint(source: string, actual: string, expected: string): void {
  if (actual !== expected)
    throw changed(source, "Workflow definition does not match its saved hash");
}

function changed(source: string, message: string): Fault {
  return new Fault(
    "workflow-definition-changed",
    `${message}; exact restore is required and no migration is available`,
    { source },
  );
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
