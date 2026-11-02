import { Fault } from "../core/json.ts";
import type { Extension, Op } from "./context.ts";

const extensionName = "@botlake/core/priming";
export const primingRegistration = Symbol.for("@botlake/core/priming-registration");

declare module "./context.ts" {
  interface Context {
    [primingRegistration](additions: ReadonlyMap<string, string>): void;
  }
}

export function priming(additions: Record<string, string>): Extension {
  const configured = new Map(Object.entries(additions));

  return {
    name: extensionName,
    activate(ctx) {
      ctx[primingRegistration](configured);
    },
  };
}

export function validatePriming(
  additions: ReadonlyMap<string, string> | undefined,
  operations: ReadonlyMap<string, Op>,
): void {
  if (additions === undefined) return;

  for (const name of additions.keys()) {
    const operation = operations.get(name);
    if (operation?.cli === undefined)
      throw new Fault("priming", `Priming target is not a CLI-visible operation: ${name}`);
  }
}

export function operationPrimer(
  additions: ReadonlyMap<string, string> | undefined,
  operation: Op,
): string {
  const addition = additions?.get(operation.name)?.trim();
  if (addition === undefined || addition.length === 0)
    return operation.primer ?? `No runbook is declared for ${operation.name}.`;
  if (operation.primer === undefined || operation.primer.trim().length === 0) return addition;
  return `${operation.primer.trimEnd()}\n\n${addition}`;
}
