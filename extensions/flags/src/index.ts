import { defineOp, encode, requireValue, type Context, type Extension } from "@botlake/core";
import { z } from "zod";

const nameSchema = z.string().trim().min(1);
const flagSchema = z.strictObject({ description: z.string().trim().min(1), value: z.boolean() });
const flagUpdateSchema = flagSchema.partial({ description: true });
const storedFlagSchema = flagSchema.readonly();
export type Flag = z.infer<typeof storedFlagSchema>;
export type FlagState = {
  current: Flag | null;
  default: Flag | null;
  overridden: boolean;
};
export const flagsConfigSchema = z.record(nameSchema, storedFlagSchema);
export function flagsConfigJsonSchema(): unknown {
  return z.toJSONSchema(flagsConfigSchema);
}
const overrideSchema = z.object({
  name: nameSchema,
  flag: z
    .string()
    .transform((text) => storedFlagSchema.parse(JSON.parse(text)))
    .nullable(),
});
const defaultsByContext = new WeakMap<Context, Map<string, Flag>>();

function defaultsFor(ctx: Context): Map<string, Flag> {
  return requireValue(
    defaultsByContext.get(ctx),
    "Flags requires the explicitly selected flags extension",
  );
}
function flagState(initial: Flag | undefined, override?: Flag | null): FlagState {
  return {
    current: (override === undefined ? initial : override) ?? null,
    default: initial ?? null,
    overridden: override !== undefined,
  };
}
export function inspectFlag(ctx: Context, name: string): FlagState {
  const initial = defaultsFor(ctx).get(name);
  const row = ctx.graph.db.query("SELECT name,flag FROM flag_overrides WHERE name=?").get(name);
  return flagState(initial, row === null ? undefined : overrideSchema.parse(row).flag);
}
export function getFlag(ctx: Context, name: string): Flag | undefined {
  return inspectFlag(ctx, name).current ?? undefined;
}
export function listFlags(ctx: Context): Record<string, FlagState> {
  const initial = defaultsFor(ctx);
  const entries = new Map([...initial].map(([name, flag]) => [name, flagState(flag)]));
  for (const row of z
    .array(overrideSchema)
    .parse(ctx.graph.db.query("SELECT name,flag FROM flag_overrides").all()))
    entries.set(row.name, flagState(initial.get(row.name), row.flag));
  return Object.fromEntries([...entries].toSorted(([a], [b]) => a.localeCompare(b)));
}
export function setFlag(
  ctx: Context,
  name: string,
  update: z.input<typeof flagUpdateSchema>,
): Flag {
  name = nameSchema.parse(name);
  return ctx.graph.atomic(() => {
    const current = getFlag(ctx, name);
    const flag = storedFlagSchema.parse({
      ...update,
      description: requireValue(
        update.description ?? current?.description,
        `New or unset flag ${name} requires a description`,
      ),
    });
    ctx.graph.db
      .query(
        "INSERT INTO flag_overrides(name,flag) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET flag=excluded.flag",
      )
      .run(name, encode(flag));
    return flag;
  });
}
export function unsetFlag(ctx: Context, name: string): boolean {
  name = nameSchema.parse(name);
  return ctx.graph.atomic(() => {
    if (getFlag(ctx, name) === undefined) return false;
    ctx.graph.db
      .query(
        "INSERT INTO flag_overrides(name,flag) VALUES(?,NULL) ON CONFLICT(name) DO UPDATE SET flag=NULL",
      )
      .run(name);
    return true;
  });
}
export function resetFlag(ctx: Context, name: string): boolean {
  defaultsFor(ctx);
  return (
    ctx.graph.db.query("DELETE FROM flag_overrides WHERE name=?").run(nameSchema.parse(name))
      .changes > 0
  );
}
export function resetFlags(ctx: Context): number {
  defaultsFor(ctx);
  return ctx.graph.db.query("DELETE FROM flag_overrides").run().changes;
}
export function flags(defaults: Record<string, Flag> = {}): Extension {
  return {
    name: "flags",
    activate(ctx) {
      const initial = new Map(Object.entries(flagsConfigSchema.parse(defaults)));
      ctx.graph.db.run(
        "CREATE TABLE IF NOT EXISTS flag_overrides(name TEXT PRIMARY KEY,flag TEXT)",
      );
      defaultsByContext.set(ctx, initial);
      ctx.resource({
        start() {},
        stop() {
          defaultsByContext.delete(ctx);
        },
      });
      ctx.register(
        defineOp({
          name: "flag",
          primer:
            "Flags are workspace-local described booleans shared by selected extensions. List and get show current and configured default records (null when absent), plus overridden to identify database overrides, including persistent unsets. Set preserves an existing description; new or unset flags require --description. Set and unset persist across restarts. Reset NAME deletes one override; reset --all deletes all overrides, restoring configured defaults and removing database-only flags. Configuration changes affect flags without overrides. Flag meanings and effects belong to consumers, not Flags.",
          input: z.discriminatedUnion("command", [
            z.strictObject({ command: z.literal("list") }),
            z.strictObject({ command: z.literal("get"), name: nameSchema }),
            flagUpdateSchema.extend({ command: z.literal("set"), name: nameSchema }),
            z.strictObject({ command: z.literal("unset"), name: nameSchema }),
            z
              .strictObject({
                command: z.literal("reset"),
                name: nameSchema.optional(),
                all: z.literal(true).optional(),
              })
              .refine(({ name, all }) => (name !== undefined) !== (all === true), {
                message: "Provide a flag name or --all, not both",
              }),
          ]),
          output: z.json(),
          cli: {
            description: "Persistent workspace-local flags and configured defaults",
            examples: [
              "bl flag list",
              "bl flag get feature/example",
              'bl flag set feature/example true --description "Enable the example feature"',
              "bl flag set feature/example false",
              "bl flag unset feature/example",
              "bl flag reset feature/example",
              "bl flag reset --all",
            ],
            commands: {
              list: {
                description: "List current flags, configured defaults and persisted overrides",
              },
              get: {
                description: "Inspect current and default records (null when absent)",
                positionals: [{ name: "name", type: "string", required: true }],
              },
              set: {
                description: "Persist a boolean; new or unset flags require a description",
                positionals: [
                  { name: "name", type: "string", required: true },
                  { name: "value", type: "boolean", required: true },
                ],
                flags: {
                  description: {
                    type: "string",
                    description:
                      "Flag meaning; required for new or unset flags, preserved when omitted",
                  },
                },
              },
              unset: {
                description: "Persistently unset a flag, including a configured default",
                positionals: [{ name: "name", type: "string", required: true }],
              },
              reset: {
                description:
                  "Restore one configured default, or all with --all; database-only flags disappear",
                positionals: [{ name: "name", type: "string" }],
                flags: {
                  all: {
                    type: "boolean",
                    description: "Delete all persisted overrides and unsets",
                  },
                },
              },
            },
          },
          handler(input) {
            switch (input.command) {
              case "list":
                return listFlags(ctx);
              case "get":
                return { name: input.name, ...inspectFlag(ctx, input.name) };
              case "set":
                return {
                  name: input.name,
                  ...setFlag(ctx, input.name, {
                    description: input.description,
                    value: input.value,
                  }),
                };
              case "unset":
                return { name: input.name, removed: unsetFlag(ctx, input.name) };
              case "reset":
                return input.name === undefined
                  ? { reset: resetFlags(ctx) }
                  : {
                      name: input.name,
                      reset: resetFlag(ctx, input.name),
                      ...inspectFlag(ctx, input.name),
                    };
            }
          },
        }),
      );
    },
  };
}

export default flags();
