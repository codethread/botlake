import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { Fault } from "@botlake/core";

import { workflowCatalogue, type Catalogue, type WorkflowFileIO } from "./catalogue.ts";

// Bun's module cache outlives a Runtime instance. Its provenance guard must too.
const importedEntries = new Map<string, string>();
const importedFolders = new Map<string, string>();

const files: WorkflowFileIO = {
  async readDirectory(path) {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.map((entry) => ({
      name: entry.name,
      kind: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
    }));
  },
  readText: (path) => readFile(path, "utf8"),
  async readBytes(path) {
    const content = await readFile(path);
    return content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength);
  },
  async isFile(path) {
    try {
      return (await stat(path)).isFile();
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
      throw error;
    }
  },
  async importModule(path, entryHash, namedProvenance) {
    const source = await realpath(path);
    assertUnchanged(source, entryHash, importedEntries);
    if (namedProvenance !== undefined) assertUnchanged(source, namedProvenance, importedFolders);
    importedEntries.set(source, entryHash);
    if (namedProvenance !== undefined) importedFolders.set(source, namedProvenance);
    return import(pathToFileURL(source).href) as Promise<unknown>;
  },
};

export function workflowFiles(workspace: string): Catalogue {
  return workflowCatalogue(workspace, files);
}

function assertUnchanged(path: string, hash: string, imported: Map<string, string>): void {
  const previous = imported.get(path);
  if (previous !== undefined && previous !== hash)
    throw new Fault(
      "workflow-restart-required",
      `Workflow source changed after it was loaded: ${path}. Restart the lake before loading it again.`,
    );
}
