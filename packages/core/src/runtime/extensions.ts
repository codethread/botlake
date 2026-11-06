import { Fault } from "../core/json.ts";
import type { Context, Extension, RuntimeExtension } from "./context.ts";

interface RuntimeExtensionDefinition<T> extends Omit<Extension, "activate"> {
  /** Register this extension and return its context-scoped public implementation. */
  activate(ctx: Context): T | Promise<T>;
}

/** Bind an activation-created implementation without selecting or starting an extension. */
export function runtimeExtension<T>(
  definition: RuntimeExtensionDefinition<T>,
): RuntimeExtension<T> {
  const instances = new WeakMap<Context, { value: T }>();
  return {
    ...definition,
    async activate(ctx) {
      const value = await definition.activate(ctx);
      instances.set(ctx, { value });
    },
    instance(ctx) {
      const entry = instances.get(ctx);
      if (entry === undefined)
        throw new Fault(
          "dependency",
          `${definition.name} is not activated in this context; explicitly select this exact binding and declare it in requires`,
        );
      return entry.value;
    },
  };
}
