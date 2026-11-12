import { Fault } from "../core/json.ts";
import type { Context, Extension, Invocation, Op } from "./context.ts";

/** Terse botlake primer to inject into session context */
export const brief = [
  "This workspace uses Botlake, a machine local sqlite db with modular extensions (one config per repo, called a 'lake')",
  "Use `bl -h` for CLI mechanics; before unfamiliar operations, run `bl prime OP`.",
  "`botlake bin list` shows additional tooling exposed in the lake, see `botlake bin -h` for details when appropriate",
  `Read ${new URL("../../README.md", import.meta.url).href} for core documentation and extension authoring.`,
  "Use `botlake lake info` to locate selected extensions' docs and source for debugging",
].join("\n");

const extensionName = "@botlake/core/priming";
export const primingRegistration = Symbol.for("@botlake/core/priming-registration");

export type PrimerCallback = (ctx: Context, invocation: Invocation) => string;
type PrimerAddition = string | PrimerCallback;

declare module "./context.ts" {
  interface Context {
    [primingRegistration](additions: ReadonlyMap<string, PrimerAddition>): void;
  }
}

export function priming(additions: Record<string, PrimerAddition>): Extension {
  const configured = new Map(Object.entries(additions));

  return {
    name: extensionName,
    source: import.meta.url,
    activate(ctx) {
      ctx[primingRegistration](configured);
    },
  };
}

export function validatePriming(
  additions: ReadonlyMap<string, PrimerAddition> | undefined,
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
  additions: ReadonlyMap<string, PrimerAddition> | undefined,
  operation: Op,
  ctx: Context,
  invocation: Invocation,
): string {
  const configured = additions?.get(operation.name);
  let result: string | undefined;
  if (typeof configured === "function") {
    const callbackResult: unknown = configured(ctx, invocation);
    if (typeof callbackResult !== "string")
      throw new Fault("priming", `Primer callback for ${operation.name} must return a string`);
    result = callbackResult;
  } else {
    result = configured;
  }

  const addition = result?.trim();
  if (addition === undefined || addition.length === 0)
    return operation.primer ?? `No runbook is declared for ${operation.name}.`;
  if (operation.primer === undefined || operation.primer.trim().length === 0) return addition;
  return `${operation.primer.trimEnd()}\n\n${addition}`;
}
