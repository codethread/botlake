import {
  Fault,
  sql,
  defineOp,
  encode,
  requireValue,
  type Context,
  type Extension,
} from "@botlake/core";
import { z } from "zod";

import { flagSchema, storedFlagSchema, type Flag } from "./node-model.ts";

export { flagSchema, storedFlagSchema, type Flag } from "./node-model.ts";

const nameSchema = z.compile(z.string().trim().min(1));

const flagUpdateSchema = z.compile(flagSchema.partial({ description: true }));

const flagStateSchema = z.strictObject({
  current: flagSchema.nullable(),
  default: flagSchema.nullable(),
  overridden: z.boolean(),
});
const outputSchema = z.compile(
  z.union([
    z.record(nameSchema, flagStateSchema),
    flagStateSchema.extend({ name: nameSchema }),
    flagSchema.extend({ name: nameSchema }),
    z.strictObject({ name: nameSchema, removed: z.boolean() }),
    flagStateSchema.extend({ name: nameSchema, reset: z.boolean() }),
    z.strictObject({ reset: z.number().int().nonnegative() }),
  ]),
);

const definitionSchema = z.compile(
  z
    .strictObject({
      name: nameSchema,
      description: z.string().trim().min(1),
      default: z.boolean(),
    })
    .readonly(),
);

export const flagsConfigSchema = z.compile(z.array(z.tuple([definitionSchema, z.boolean()])));

const overrideSchema = z.compile(
  z.object({
    name: nameSchema,
    flag: z
      .string()
      .transform((text) => storedFlagSchema.parse(JSON.parse(text)))
      .nullable(),
  }),
);
const overridesSchema = z.compile(z.array(overrideSchema));

const defaultsByContext = new WeakMap<Context, Map<string, Flag>>();

export type FlagDefinition = z.infer<typeof definitionSchema>;

export type FlagSetting = readonly [FlagDefinition, boolean];

// Keep this closed payload assignable to the operation's JSON output.
export type FlagState = {
  /** Effective flag, or null when absent or explicitly unset. */
  current: Flag | null;
  /** Configured flag, or null when no default exists. */
  default: Flag | null;
  /** Whether the database stores an override, including an explicit unset. */
  overridden: boolean;
};

export function flags<K extends string>(
  definitions: Record<K, FlagDefinition>,
): Readonly<Record<K, FlagDefinition>> {
  const defined = { ...definitions };
  const names = new Set<string>();
  for (const key in defined) {
    const definition = definitionSchema.parse(defined[key]);
    if (names.has(definition.name))
      throw new Fault("collision", `Duplicate flag definition: ${definition.name}`);
    names.add(definition.name);
    defined[key] = definition;
  }
  return Object.freeze(defined);
}

export function flagsConfigJsonSchema(): unknown {
  return z.toJSONSchema(flagsConfigSchema);
}

export function inspectFlag(ctx: Context, target: string | FlagDefinition): FlagState {
  const name = flagName(target);
  const initial = defaultsFor(ctx).get(name);
  const row = ctx.graph.db
    .query(sql`
      SELECT name, flag
      FROM flag_overrides
      WHERE name = ?
    `)
    .get(name);

  return flagState(initial, row === null ? undefined : overrideSchema.parse(row).flag);
}

export function getFlag(ctx: Context, target: string | FlagDefinition): Flag | undefined {
  return inspectFlag(ctx, target).current ?? undefined;
}

export function listFlags(ctx: Context): Record<string, FlagState> {
  const initial = defaultsFor(ctx);
  const entries = new Map([...initial].map(([name, flag]) => [name, flagState(flag)]));

  for (const row of overridesSchema.parse(
    ctx.graph.db
      .query(sql`
        SELECT name, flag
        FROM flag_overrides
      `)
      .all(),
  ))
    entries.set(row.name, flagState(initial.get(row.name), row.flag));

  return Object.fromEntries([...entries].toSorted(([a], [b]) => a.localeCompare(b)));
}

export function setFlag(
  ctx: Context,
  target: FlagDefinition,
  update: boolean | z.input<typeof flagUpdateSchema>,
): Flag;
export function setFlag(
  ctx: Context,
  target: string,
  update: z.input<typeof flagUpdateSchema>,
): Flag;
export function setFlag(
  ctx: Context,
  target: string | FlagDefinition,
  update: boolean | z.input<typeof flagUpdateSchema>,
): Flag {
  const name = nameSchema.parse(flagName(target));
  const value = typeof update === "boolean" ? { value: update } : update;

  return ctx.graph.atomic(() => {
    const current = getFlag(ctx, name);
    const flag = storedFlagSchema.parse({
      ...value,
      description: requireValue(
        value.description ??
          current?.description ??
          (typeof target === "string" ? undefined : target.description),
        `New or unset flag ${name} requires a description`,
      ),
    });
    ctx.graph.db
      .query(sql`
        INSERT INTO flag_overrides (name, flag)
        VALUES (?, ?)
        ON CONFLICT (name) DO UPDATE SET
          flag = excluded.flag
      `)
      .run(name, encode(flag));

    return flag;
  });
}

export function unsetFlag(ctx: Context, target: string | FlagDefinition): boolean {
  const name = nameSchema.parse(flagName(target));

  return ctx.graph.atomic(() => {
    if (getFlag(ctx, name) === undefined) return false;

    ctx.graph.db
      .query(sql`
        INSERT INTO flag_overrides (name, flag)
        VALUES (?, NULL)
        ON CONFLICT (name) DO UPDATE SET
          flag = NULL
      `)
      .run(name);

    return true;
  });
}

export function resetFlag(ctx: Context, target: string | FlagDefinition): boolean {
  defaultsFor(ctx);

  return (
    ctx.graph.db
      .query(sql`
        DELETE FROM flag_overrides
        WHERE name = ?
      `)
      .run(nameSchema.parse(flagName(target))).changes > 0
  );
}

export function resetFlags(ctx: Context): number {
  defaultsFor(ctx);

  return ctx.graph.db
    .query(sql`
      DELETE FROM flag_overrides
    `)
    .run().changes;
}

export function configureFlags(settings: readonly FlagSetting[]): Extension {
  const defaults = new Map<string, Flag>();
  for (const [definition, value] of flagsConfigSchema.parse(settings)) {
    if (defaults.has(definition.name))
      throw new Fault("collision", `Duplicate configured flag: ${definition.name}`);
    defaults.set(definition.name, Object.freeze({ description: definition.description, value }));
  }

  return {
    name: "flags",
    activate(ctx) {
      const initial = new Map(defaults);
      ctx.graph.db.run(sql`
        CREATE TABLE IF NOT EXISTS flag_overrides (
          name TEXT PRIMARY KEY,
          flag TEXT
        )
      `);
      defaultsByContext.set(ctx, initial);
      ctx.resource({
        start() {},
        stop() {
          defaultsByContext.delete(ctx);
        },
      });
      const commandSchema = z.compile(
        z.union([
          z.strictObject({ command: z.literal("list") }),
          z.strictObject({ command: z.literal("get"), name: nameSchema }),
          flagUpdateSchema.extend({ command: z.literal("set"), name: nameSchema }),
          z.strictObject({ command: z.literal("unset"), name: nameSchema }),
          z.strictObject({ command: z.literal("reset"), name: nameSchema }),
          z.strictObject({ command: z.literal("reset"), all: z.literal(true) }),
        ]),
      );
      ctx.register(
        defineOp({
          name: "flag",
          about:
            "Flags are workspace-local described booleans. Selected extensions configure defaults; persistent database overrides take precedence. The consuming extension defines each flag's meaning and when changes take effect.",
          primer:
            "Use bl flag list or get to inspect current/default values and overrides. Set a value, persistently unset it, or reset an override to its configured default (database-only flags disappear). New or unset flags need --description; reset --all removes every override and unset.",
          input: commandSchema,
          output: outputSchema,
          jsonSchema: { input: commandSchema, output: outputSchema },
          cli: {
            description: "Inspect and change persistent workspace flag values",
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
                description:
                  "List the complete unpaged name-keyed map of current/default records and override status, including unsets",
                examples: ["bl flag list"],
              },
              get: {
                description:
                  "Show one flag's current/default records and override status; absent values are null",
                examples: ["bl flag get feature/example"],
                positionals: [{ name: "name", type: "string", required: true }],
              },
              set: {
                description: "Persist true or false; returns the new value and description",
                examples: [
                  'bl flag set feature/example true --description "Enable the example feature"',
                  "bl flag set feature/example false",
                ],
                positionals: [
                  { name: "name", type: "string", required: true },
                  {
                    name: "value",
                    type: "boolean",
                    required: true,
                    description: "Boolean: true or false",
                  },
                ],
                flags: {
                  description: {
                    type: "string",
                    description:
                      "Nonblank; required for new or unset flags, replaces existing text when supplied",
                  },
                },
              },
              unset: {
                description:
                  "Persistently unset a current/configured flag; returns whether a value was removed",
                examples: ["bl flag unset feature/example"],
                positionals: [{ name: "name", type: "string", required: true }],
              },
              reset: {
                description:
                  "Delete one override or all; choose exactly NAME or --all. Returns restored state or reset count",
                examples: ["bl flag reset feature/example", "bl flag reset --all"],
                positionals: [
                  { name: "name", type: "string", description: "Flag name; omit with --all" },
                ],
                flags: {
                  all: {
                    type: "boolean",
                    description: "Reset all overrides and unsets; use instead of NAME",
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
                return "name" in input
                  ? {
                      name: input.name,
                      reset: resetFlag(ctx, input.name),
                      ...inspectFlag(ctx, input.name),
                    }
                  : { reset: resetFlags(ctx) };
            }
          },
        }),
      );
    },
  };
}

export default configureFlags([]);

// -- Private helpers --

function flagName(target: string | FlagDefinition): string {
  return typeof target === "string" ? target : target.name;
}

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
