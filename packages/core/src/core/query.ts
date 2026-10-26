import type { SQLQueryBindings } from "bun:sqlite";

import { match, P } from "ts-pattern";
import { z } from "zod";

import { Fault, type Json } from "./json.ts";

const fieldSchema = z.union([
  z.enum(["id", "title", "state", "created_at", "updated_at", "revision"]),
  z.strictObject({ attr: z.string().min(1), path: z.array(z.string().min(1)).default([]) }),
]);
const valueSchema = z.union([z.json(), z.strictObject({ param: z.string().min(1) })]);
export type Field = z.infer<typeof fieldSchema>;
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
    return "?";
  }
  function negate(sql: string, negated: boolean): string {
    return negated ? `(NOT (${sql}))` : sql;
  }
  function visit(predicate: Predicate, alias: string, inEdge: boolean, negated = false): string {
    return match(predicate)
      .returnType<string>()
      .with(
        { op: P.union("and", "or") },
        (node) =>
          `(${node.args.map((arg) => visit(arg, alias, inEdge, negated)).join((node.op === "and") !== negated ? " AND " : " OR ")})`,
      )
      .with({ op: "not" }, ({ arg }) => visit(arg, alias, inEdge, !negated))
      .with({ op: "edge" }, (node) => {
        if (inEdge) throw new Fault("query", "Nested edge predicates are not supported");
        const edge = `e${++counter}`;
        const endpoint = `s${counter}`;
        const from = node.direction === "out" ? "from_id" : "to_id";
        const to = node.direction === "out" ? "to_id" : "from_id";
        const rel = bind(node.relation);
        const where = node.where === undefined ? "1" : visit(node.where, endpoint, true);
        return negate(
          `EXISTS (SELECT 1 FROM edges ${edge} JOIN strands ${endpoint} ON ${endpoint}.id=${edge}.${to} WHERE ${edge}.${from}=${alias}.id AND ${edge}.relation=${rel} AND ${where})`,
          negated,
        );
      })
      .with({ op: P.union("exists", "missing", "=", "!=", "<", "<=", ">", ">=", "in") }, (node) => {
        let prefix = "";
        let suffix = "";
        let expression: string;
        if (typeof node.field === "string") expression = `${alias}.${node.field}`;
        else {
          const attr = `a${++counter}`;
          const key = bind(node.field.attr);
          const path = bind(
            `$${node.field.path.map((part) => `.${JSON.stringify(part)}`).join("")}`,
          );
          expression = `json_extract(${attr}.value, ${path})`;
          prefix = `EXISTS (SELECT 1 FROM attributes ${attr} WHERE ${attr}.strand_id=${alias}.id AND ${attr}.archived=0 AND ${attr}.key=${key} AND `;
          suffix = ")";
        }
        if (node.op === "exists" || node.op === "missing") {
          const exists = `${prefix}${expression} IS NOT NULL${suffix}`;
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
          return `${prefix}${negate(`${expression} IN (${value.map((entry) => bind(entry)).join(",")})`, negated)}${suffix}`;
        }
        return `${prefix}${negate(`${expression} ${node.op === "!=" ? "<>" : node.op} ${bind(value)}`, negated)}${suffix}`;
      })
      .exhaustive();
  }
  const sql = visit(predicateSchema.parse(input), "s", false);
  return { sql, bindings };
}

export interface NamedQuery {
  where: Predicate;
  params?: string[] | undefined;
  description: string;
}
export const namedQuerySchema = z.strictObject({
  where: predicateSchema,
  params: z.array(z.string().min(1)).optional(),
  description: z.string().min(1),
});

export function equals(attr: string, value: Json): Predicate {
  return { op: "=", field: { attr, path: [] }, value };
}
