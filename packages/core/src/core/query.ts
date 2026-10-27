import type { SQLQueryBindings } from "bun:sqlite";

import { match, P } from "ts-pattern";
import { z } from "zod";

import { Fault, type Json } from "./json.ts";
import { sql } from "./sql.ts";

const fieldSchema = z.union([
  z.enum(["id", "title", "state", "created_at", "updated_at", "revision"]),
  z.strictObject({ attr: z.string().min(1), path: z.array(z.string().min(1)).default([]) }),
]);

const valueSchema = z.union([z.json(), z.strictObject({ param: z.string().min(1) })]);

export const predicateSchema: z.ZodType<Predicate> = z.lazy(() =>
  z.union([
    z.strictObject({ op: z.enum(["and", "or"]), args: z.array(predicateSchema).min(1) }),
    z.strictObject({ op: z.literal("not"), arg: predicateSchema }),
    z.strictObject({ op: z.enum(["exists", "missing"]), field: fieldSchema }),
    z.strictObject({
      op: z.enum(["=", "!=", "<", "<=", ">", ">=", "in"]),
      field: fieldSchema,
      value: valueSchema,
    }),
    z.strictObject({
      op: z.literal("edge"),
      direction: z.enum(["in", "out"]),
      relation: z.string().min(1),
      where: predicateSchema.optional(),
    }),
  ]),
);

export const namedQuerySchema = z.strictObject({
  where: predicateSchema,
  params: z.array(z.string().min(1)).optional(),
  description: z.string().min(1),
});

export const q = {
  attr(attr: string, ...path: string[]): Field {
    return { attr, path };
  },

  param(param: string): QueryParameter {
    return { param };
  },

  and(...args: [Predicate, ...Predicate[]]): Predicate {
    return { op: "and", args };
  },

  or(...args: [Predicate, ...Predicate[]]): Predicate {
    return { op: "or", args };
  },

  not(arg: Predicate): Predicate {
    return { op: "not", arg };
  },

  exists(field: Field): Predicate {
    return { op: "exists", field };
  },

  missing(field: Field): Predicate {
    return { op: "missing", field };
  },

  eq(field: Field, value: Json | QueryParameter): Predicate {
    return { op: "=", field, value };
  },

  ne(field: Field, value: Json | QueryParameter): Predicate {
    return { op: "!=", field, value };
  },

  lt(field: Field, value: Json | QueryParameter): Predicate {
    return { op: "<", field, value };
  },

  lte(field: Field, value: Json | QueryParameter): Predicate {
    return { op: "<=", field, value };
  },

  gt(field: Field, value: Json | QueryParameter): Predicate {
    return { op: ">", field, value };
  },

  gte(field: Field, value: Json | QueryParameter): Predicate {
    return { op: ">=", field, value };
  },

  inArray(field: Field, value: readonly Json[] | QueryParameter): Predicate {
    return { op: "in", field, value: "param" in value ? value : [...value] };
  },

  edgeOut(relation: string, where?: Predicate): Predicate {
    return { op: "edge", direction: "out", relation, ...(where === undefined ? {} : { where }) };
  },

  edgeIn(relation: string, where?: Predicate): Predicate {
    return { op: "edge", direction: "in", relation, ...(where === undefined ? {} : { where }) };
  },
};

export type Field = z.infer<typeof fieldSchema>;

export interface QueryParameter {
  /** Name resolved from the query's supplied parameter values. */
  param: string;
}

export type Predicate =
  | { op: "and" | "or"; args: Predicate[] }
  | { op: "not"; arg: Predicate }
  | { op: "exists"; field: Field }
  | { op: "missing"; field: Field }
  | {
      op: "=" | "!=" | "<" | "<=" | ">" | ">=" | "in";
      field: Field;
      value: Json | { param: string };
    }
  | { op: "edge"; direction: "in" | "out"; relation: string; where?: Predicate | undefined };

export interface NamedQuery {
  where: Predicate;
  params?: string[] | undefined;
  description: string;
}

export function compileQuery(
  input: unknown,
  params: Record<string, Json> = {},
): { sql: string; bindings: SQLQueryBindings[] } {
  const bindings: SQLQueryBindings[] = [];
  let counter = 0;
  function bind(value: Json): string {
    bindings.push(
      typeof value === "object" && value !== null
        ? JSON.stringify(value)
        : typeof value === "boolean"
          ? Number(value)
          : value,
    );
    return sql`?`;
  }
  function negate(expression: string, negated: boolean): string {
    return negated ? sql`(NOT (${expression}))` : expression;
  }
  function visit(predicate: Predicate, alias: string, inEdge: boolean, negated = false): string {
    return match(predicate)
      .returnType<string>()
      .with(
        { op: P.union("and", "or") },
        (node) =>
          sql`(${node.args
            .map((arg) => visit(arg, alias, inEdge, negated))
            .join((node.op === "and") !== negated ? sql` AND ` : sql` OR `)})`,
      )
      .with({ op: "not" }, ({ arg }) => visit(arg, alias, inEdge, !negated))
      .with({ op: "edge" }, (node) => {
        if (inEdge) throw new Fault("query", "Nested edge predicates are not supported");
        const edge = `e${++counter}`;
        const endpoint = `s${counter}`;
        const from = node.direction === "out" ? "from_id" : "to_id";
        const to = node.direction === "out" ? "to_id" : "from_id";
        const rel = bind(node.relation);
        const where = node.where === undefined ? sql`1` : visit(node.where, endpoint, true);
        return negate(
          sql`EXISTS (
            SELECT 1
            FROM edges ${edge}
            JOIN nodes ${endpoint} ON ${endpoint}.id = ${edge}.${to}
            WHERE ${edge}.${from} = ${alias}.id
              AND ${edge}.relation = ${rel}
              AND ${where}
          )`,
          negated,
        );
      })
      .with({ op: P.union("exists", "missing", "=", "!=", "<", "<=", ">", ">=", "in") }, (node) => {
        let prefix = "";
        let suffix = "";
        let expression: string;
        if (typeof node.field === "string") expression = sql`${alias}.${node.field}`;
        else {
          const attr = `a${++counter}`;
          const key = bind(node.field.attr);
          const path = bind(
            `$${node.field.path.map((part) => `.${JSON.stringify(part)}`).join("")}`,
          );
          expression = sql`json_extract(${attr}.value, ${path})`;
          prefix = sql`EXISTS (
            SELECT 1
            FROM attributes ${attr}
            WHERE ${attr}.node_id = ${alias}.id
              AND ${attr}.archived = 0
              AND ${attr}.key = ${key}
              AND `;
          suffix = sql`)`;
        }
        if (node.op === "exists" || node.op === "missing") {
          const exists = sql`${prefix}${expression} IS NOT NULL${suffix}`;
          return negate(exists, (node.op === "missing") !== negated);
        }
        let value = node.value;
        if (
          typeof value === "object" &&
          value !== null &&
          !Array.isArray(value) &&
          "param" in value
        ) {
          const name = z.string().parse(value.param);
          const resolved = params[name];
          if (resolved === undefined) throw new Fault("query", `Missing query parameter: ${name}`);
          value = resolved;
        }
        if (node.op === "in") {
          if (!Array.isArray(value) || value.length === 0)
            throw new Fault("query", "in requires a nonempty array");
          const placeholders = value.map((entry) => bind(entry)).join(", ");
          const comparison = sql`${expression} IN (${placeholders})`;
          return sql`${prefix}${negate(comparison, negated)}${suffix}`;
        }
        const comparison = sql`${expression} ${node.op === "!=" ? "<>" : node.op} ${bind(value)}`;
        return sql`${prefix}${negate(comparison, negated)}${suffix}`;
      })
      .exhaustive();
  }
  return { sql: visit(predicateSchema.parse(input), "s", false), bindings };
}
