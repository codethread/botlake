import type { StandardSchemaV1 } from "@standard-schema/spec";
import { z } from "zod";

import { attributesSchema, Fault, type Attributes } from "../core/json.ts";
import { predicateSchema, type Predicate, type NamedQuery } from "../core/query.ts";
import { batchSchema } from "../core/store.ts";
import type { Command } from "../runtime/cli.ts";
import { defineOp } from "../runtime/ops.ts";
import type { Context, Spool } from "../runtime/runtime.ts";

const id = z.string().min(1);
const patch = {
  title: z.string().min(1).optional(),
  state: z.enum(["active", "closed"]).optional(),
  attributes: attributesSchema.optional(),
  expectedRevision: z.number().int().positive().optional(),
};
const queryInput = z.strictObject({
  query: z.string().optional(),
  where: predicateSchema.optional(),
  params: attributesSchema.optional(),
  limit: z.number().int().positive().optional(),
  lean: z.boolean().optional(),
});
export function batteries(queries: Record<string, NamedQuery> = {}): Spool {
  return {
    name: "batteries",
    activate(ctx) {
      for (const [name, query] of Object.entries(queries)) ctx.registerQuery(name, query);
      function register<I extends z.ZodType>(
        name: string,
        input: I,
        handler: (input: StandardSchemaV1.InferOutput<I>, context: Context) => unknown,
        positionals: NonNullable<Command["positionals"]> = [],
        flags: NonNullable<Command["flags"]> = {},
        commands?: Record<string, Command>,
      ): void {
        ctx.register(
          defineOp({
            name,
            input,
            output: z.json(),
            cli: {
              description: name,
              positionals,
              flags,
              ...(commands === undefined ? {} : { commands }),
            },
            jsonSchema: { input, output: z.json() },
            handler: (value, context) => z.json().parse(handler(value, context)),
          }),
        );
      }
      register(
        "add",
        z.strictObject({
          title: id,
          state: z.enum(["active", "closed"]).optional(),
          attributes: attributesSchema.optional(),
        }),
        (input) => ctx.graph.add(input),
        [{ name: "title", type: "string", required: true }],
        { state: { type: "string" }, attributes: { type: "json" } },
      );
      register(
        "show",
        z.strictObject({ id, lean: z.boolean().optional() }),
        (input) => ctx.graph.show(input.id, input.lean),
        [{ name: "id", type: "string", required: true }],
        { lean: { type: "boolean" } },
      );
      register(
        "update",
        z.strictObject({ id, ...patch }),
        ({ id: strand, ...input }) => ctx.graph.update(strand, input),
        [{ name: "id", type: "string", required: true }],
        {
          title: { type: "string" },
          state: { type: "string" },
          attributes: { type: "json" },
          "expected-revision": { key: "expectedRevision", type: "number" },
        },
      );
      for (const ready of [false, true])
        register(
          ready ? "ready" : "list",
          queryInput,
          (input) => {
            let where = input.where;
            if (input.query !== undefined) {
              const named = ctx.namedQuery(input.query);
              if (named === undefined) throw new Fault("query", `Unknown query: ${input.query}`);
              if (where !== undefined) throw new Fault("query", "Choose named or ad hoc query");
              for (const param of named.params ?? [])
                if (input.params?.[param] === undefined)
                  throw new Fault("query", `Missing parameter: ${param}`);
              where = named.where;
            }
            return ctx.graph.list({ ...input, where, ready });
          },
          [],
          {
            query: { type: "string" },
            where: { type: "json" },
            params: { type: "json" },
            limit: { type: "number" },
            lean: { type: "boolean" },
          },
        );
      register(
        "query",
        z.strictObject({ name: id.optional() }),
        ({ name }) =>
          name === undefined
            ? ctx.queryCatalog()
            : (ctx.namedQuery(name) ??
              (() => {
                throw new Fault("query", `Unknown query: ${name}`);
              })()),
        [{ name: "name", type: "string" }],
      );
      register("batch", batchSchema, (input) => ctx.graph.batch(input), [], {
        refs: { type: "json" },
        strands: { type: "json" },
        edges: { type: "json" },
        burn: { type: "json" },
      });
      register(
        "supersede",
        z.strictObject({ id, replacement: id }),
        (input) => ctx.graph.supersede(input.id, input.replacement),
        [
          { name: "id", type: "string", required: true },
          { name: "replacement", type: "string", required: true },
        ],
      );
      register(
        "burn",
        z.strictObject({ ids: z.array(id).min(1) }),
        (input) => ctx.graph.burn(input.ids),
        [{ name: "ids", type: "string", multiple: true, required: true }],
      );
      register(
        "note",
        z.strictObject({ id, text: id, attributes: attributesSchema.optional() }),
        (input) => ctx.graph.note(input.id, input.text, input.attributes),
        [
          { name: "id", type: "string", required: true },
          { name: "text", type: "string", required: true },
        ],
        { attributes: { type: "json" } },
      );
      register(
        "archive",
        z.strictObject({ id, keys: z.array(id) }),
        (input) => ctx.graph.archive(input.id, input.keys),
        [
          { name: "id", type: "string", required: true },
          { name: "keys", type: "string", multiple: true, required: true },
        ],
      );
      register(
        "subgraph",
        z.strictObject({ id, relation: id.optional() }),
        (input) => ctx.graph.subgraph(input.id, input.relation),
        [{ name: "id", type: "string", required: true }],
      );
      register(
        "edge",
        z.discriminatedUnion("command", [
          z.strictObject({
            command: z.literal("add"),
            from: id,
            to: id,
            relation: id,
            attributes: attributesSchema.optional(),
          }),
          z.strictObject({ command: z.literal("remove"), from: id, to: id, relation: id }),
          z.strictObject({
            command: z.literal("list"),
            id: id.optional(),
            relation: id.optional(),
          }),
        ]),
        (input) => {
          switch (input.command) {
            case "add":
              return ctx.graph.connect(input.from, input.to, input.relation, input.attributes);
            case "remove":
              return ctx.graph.disconnect(input.from, input.to, input.relation);
            case "list":
              return ctx.graph.edges(input.id, input.relation);
          }
        },
        [],
        {},
        {
          add: {
            description: "Add named edge",
            positionals: [
              { name: "from", type: "string", required: true },
              { name: "to", type: "string", required: true },
              { name: "relation", type: "string", required: true },
            ],
            flags: { attributes: { type: "json" } },
          },
          remove: {
            description: "Remove exact edge",
            positionals: [
              { name: "from", type: "string", required: true },
              { name: "to", type: "string", required: true },
              { name: "relation", type: "string", required: true },
            ],
          },
          list: {
            description: "Edges",
            positionals: [{ name: "id", type: "string" }],
            flags: { relation: { type: "string" } },
          },
        },
      );
    },
  };
}
export function equals(attr: string, value: Attributes[string]): Predicate {
  return { op: "=", field: { attr, path: [] }, value };
}
