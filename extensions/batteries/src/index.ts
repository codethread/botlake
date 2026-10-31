import {
  attributesSchema,
  jsonSchema,
  batchSchema,
  defineOp,
  Fault,
  q,
  type NamedQuery,
  type Command,
  type Context,
  type Extension,
} from "@botlake/core";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { z } from "zod";

import { registerAwait } from "./await.ts";
import { registerNode } from "./node.ts";

const coordinationQueries: Record<string, NamedQuery> = {
  "node-closed": {
    description: "Closed node with the supplied id",
    params: ["id"],
    where: q.and(q.eq("id", q.param("id")), q.eq("state", "closed")),
  },
  "node-active": {
    description: "Active node with the supplied id",
    params: ["id"],
    where: q.and(q.eq("id", q.param("id")), q.eq("state", "active")),
  },
  "children-active": {
    description: "Active children of the supplied parent",
    params: ["parent"],
    where: q.and(q.eq("state", "active"), q.edgeIn("parent-of", q.eq("id", q.param("parent")))),
  },
  "blockers-active": {
    description: "Active prerequisites of the supplied node",
    params: ["id"],
    where: q.and(q.eq("state", "active"), q.edgeIn("depends-on", q.eq("id", q.param("id")))),
  },
};

const id = z.compile(z.string().min(1));

const queryInput = z.compile(
  z.strictObject({
    name: id.optional(),
  }),
);

const batchFlags: NonNullable<Command["flags"]> = {
  refs: { type: "json" },
  nodes: { type: "json" },
  edges: { type: "json" },
  burn: { type: "json" },
};

const guidance = {
  query: {
    description: "Inspect registered query definitions",
    primer:
      "List query names, inspect a definition and its parameters, then use it with bl node list or bl node ready.",
    examples: ["bl query", "bl query NAME"],
  },
  batch: {
    description: "Apply node and edge mutations atomically",
    primer:
      "Bind durable ids in refs; name new nodes with local refs. Supply ordered edge operations and optional expectedRevision values. Any failure rolls back the entire batch.",
    examples: ["bl --input @batch.json batch"],
  },
  edge: {
    description: "Add, remove or inspect named graph edges",
    primer:
      "Edges point from a source to a target. depends-on points from dependent to prerequisite; parent-of points from parent to child. Declared acyclic relations reject cycles; serves allows one target per source.",
    examples: ["bl edge add TASK_ID PREREQUISITE_ID depends-on", "bl edge list ID"],
  },
};

export function batteries(queries: Record<string, NamedQuery> = {}): Extension {
  return {
    name: "batteries",
    activate(ctx) {
      for (const [name, query] of [
        ...Object.entries(coordinationQueries),
        ...Object.entries(queries),
      ])
        ctx.registerQuery(name, query);
      registerAwait(ctx);
      registerNode(ctx);
      function register<I extends z.ZodType>(
        name: keyof typeof guidance,
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
            output: jsonSchema,
            primer: guidance[name].primer,
            cli: {
              description: guidance[name].description,
              examples: guidance[name].examples,
              ...(commands === undefined ? { positionals, flags } : { commands }),
            },
            jsonSchema: { input, output: jsonSchema },
            handler: (value, context) => jsonSchema.parse(handler(value, context)),
          }),
        );
      }
      register(
        "query",
        queryInput,
        ({ name }) =>
          name === undefined
            ? ctx.queryCatalog()
            : (ctx.namedQuery(name) ??
              (() => {
                throw new Fault("query", `Unknown query: ${name}`);
              })()),
        [{ name: "name", type: "string" }],
      );
      register("batch", batchSchema, (input) => ctx.graph.batch(input), [], batchFlags);
      register(
        "edge",
        z.compile(
          z.discriminatedUnion("command", [
            z.strictObject({
              command: z.literal("add"),
              from: id,
              to: id,
              relation: id,
              attributes: attributesSchema.optional(),
            }),
            z.strictObject({
              command: z.literal("remove"),
              from: id,
              to: id,
              relation: id,
            }),
            z.strictObject({
              command: z.literal("list"),
              id: id.optional(),
              relation: id.optional(),
            }),
          ]),
        ),
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

export default batteries();
