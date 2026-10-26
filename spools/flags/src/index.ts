import { defineOp, requireValue, type Context, type Spool } from "@millstrand/core";
import { z } from "zod";

const nameSchema = z.string().trim().min(1);
export const flagsConfigSchema = z.record(nameSchema, z.boolean());
export function flagsConfigJsonSchema(): unknown {
  return z.toJSONSchema(flagsConfigSchema);
}
const states = new WeakMap<Context, Map<string, boolean>>();

function state(ctx: Context): Map<string, boolean> {
  return requireValue(states.get(ctx), "Flags requires the explicitly selected flags spool");
}
export function getFlag(ctx: Context, name: string): boolean | undefined {
  return state(ctx).get(name);
}
export function listFlags(ctx: Context): Record<string, boolean> {
  return Object.fromEntries([...state(ctx)].toSorted(([a], [b]) => a.localeCompare(b)));
}
export function setFlag(ctx: Context, name: string, value: boolean): void {
  state(ctx).set(nameSchema.parse(name), z.boolean().parse(value));
}
export function unsetFlag(ctx: Context, name: string): boolean {
  return state(ctx).delete(nameSchema.parse(name));
}
export function flags(defaults: Record<string, boolean> = {}): Spool {
  return {
    name: "flags",
    activate(ctx) {
      states.set(ctx, new Map(Object.entries(flagsConfigSchema.parse(defaults))));
      ctx.resource({
        start() {},
        stop() {
          states.delete(ctx);
        },
      });
      ctx.register(
        defineOp({
          name: "flag",
          primer:
            "Flags are workspace-local booleans shared by selected spools. Get distinguishes an unset flag from false. Set and unset last until Weaver restart; configured defaults are reapplied on restart. Flag meanings and effects belong to consumers, not Flags.",
          input: z.discriminatedUnion("command", [
            z.strictObject({ command: z.literal("list") }),
            z.strictObject({ command: z.literal("get"), name: nameSchema }),
            z.strictObject({ command: z.literal("set"), name: nameSchema, value: z.boolean() }),
            z.strictObject({ command: z.literal("unset"), name: nameSchema }),
          ]),
          output: z.json(),
          cli: {
            description: "Workspace-local runtime flags",
            examples: [
              "strand flag list",
              "strand flag get feature/example",
              "strand flag set feature/example false",
              "strand flag unset feature/example",
            ],
            commands: {
              list: { description: "List set flags" },
              get: {
                description: "Get a flag (null when unset)",
                positionals: [{ name: "name", type: "string", required: true }],
              },
              set: {
                description: "Set a boolean until Weaver restart",
                positionals: [
                  { name: "name", type: "string", required: true },
                  { name: "value", type: "boolean", required: true },
                ],
              },
              unset: {
                description: "Remove a flag until Weaver restart",
                positionals: [{ name: "name", type: "string", required: true }],
              },
            },
          },
          handler(input) {
            switch (input.command) {
              case "list":
                return listFlags(ctx);
              case "get":
                return { name: input.name, value: getFlag(ctx, input.name) ?? null };
              case "set":
                setFlag(ctx, input.name, input.value);
                return { name: input.name, value: input.value };
              case "unset":
                return { name: input.name, removed: unsetFlag(ctx, input.name) };
            }
          },
        }),
      );
    },
  };
}

export default flags();
