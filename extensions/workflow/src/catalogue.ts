import { Fault } from "@botlake/core";
import type { ProbeDefinition } from "@botlake/extension-work";

import type { Definition } from "./definition.ts";
import type { Locator } from "./node-model.ts";

export interface LoadedDefinition {
  /** Trusted configured behavior. */
  definition: Definition;
  /** Durable identity saved with each run. */
  locator: Locator;
}

export type Catalogue = ReturnType<typeof workflowCatalogue>;

/** Configured definitions and their persisted identities; never discovers or imports files. */
export function workflowCatalogue(definitions: readonly Definition[]) {
  const configured = new Map<string, Definition>();
  for (const definition of definitions) {
    if (configured.has(definition.name))
      throw new Fault("workflow", `Duplicate workflow name: ${definition.name}`);
    configured.set(definition.name, definition);
  }

  return {
    list() {
      return [...configured.values()]
        .map(({ name, version, description }) => ({ name, version, description }))
        .toSorted((left, right) => left.name.localeCompare(right.name));
    },
    load,
    restore(locator: Locator): LoadedDefinition {
      const loaded = load(locator.name);
      if (loaded.locator.version !== locator.version)
        throw new Fault(
          "workflow-definition-changed",
          `Expected workflow ${locator.name} version ${locator.version}, found ${loaded.locator.version}; exact restore is required and no migration is available`,
        );
      return loaded;
    },
    probe(key: string): ProbeDefinition | undefined {
      const separator = key.indexOf("/");
      if (separator <= 0 || separator === key.length - 1) return;
      const definition = configured.get(key.slice(0, separator));
      return definition?.probes.find((probe) => probe.name === key.slice(separator + 1));
    },
  };

  function load(name: string): LoadedDefinition {
    const definition = configured.get(name);
    if (definition === undefined)
      throw new Fault(
        "workflow-missing",
        `Workflow ${name} is not configured; inspect bl workflow catalog`,
      );
    return { definition, locator: { name: definition.name, version: definition.version } };
  }
}
