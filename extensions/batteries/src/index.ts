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
  refs: { type: "json", description: "Local names mapped to existing node IDs (default {})" },
  nodes: { type: "json", description: "Node patches with local refs (default [])" },
  edges: { type: "json", description: "Ordered upsert/remove edge operations (default [])" },
  burn: { type: "json", description: "Local refs to delete atomically (default [])" },
};

const guidance = {
  query: {
    description: "List query summaries; pass NAME to inspect its predicate",
    about:
      "Named queries are registered predicates with parameter names, not materialized results. Selection runs against current hot graph data.",
    primer:
      "List query names, descriptions and parameter names. Pass NAME to expand its predicate, then use it with bl node list/ready --query NAME --params JSON.",
    examples: ["bl query", "bl query NAME"],
  },
  batch: {
    description: "Apply node and edge mutations atomically",
    about:
      "A batch is one graph transaction. Local refs connect new and existing nodes; domain guards still apply, and any failure rolls back every change.",
    primer:
      "Bind durable ids in refs; name new nodes with local refs. Supply ordered edge operations and optional expectedRevision values. Any failure rolls back the entire batch.",
    examples: ["bl --input @batch.json batch"],
  },
  edge: {
    description: "Add, remove or inspect named graph edges",
    about:
      "Edges are directed, named relationships with optional attributes. Declared acyclic relations reject cycles; domain extensions may impose additional guards.",
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
            about: guidance[name].about,
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
            ? Object.fromEntries(
                Object.entries(ctx.queryCatalog()).map(([key, query]) => [
                  key,
                  { description: query.description, params: query.params ?? [] },
                ]),
              )
            : (ctx.namedQuery(name) ??
              (() => {
                throw new Fault("query", `Unknown query: ${name}`);
              })()),
        [{ name: "name", type: "string", description: "Expand one registered query definition" }],
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
              limit: z.number().int().min(1).max(100).default(20),
              offset: z.number().int().nonnegative().default(0),
              lean: z.boolean().default(true),
            }),
          ]),
        ),
        (input) => {
          switch (input.command) {
            case "add":
              return ctx.graph.connect(input.from, input.to, input.relation, input.attributes);
            case "remove":
              return ctx.graph.disconnect(input.from, input.to, input.relation);
            case "list": {
              const edges = ctx.graph.edges(input.id, input.relation);
              return {
                edges: edges
                  .slice(input.offset, input.offset + input.limit)
                  .map((edge) =>
                    input.lean
                      ? { from_id: edge.from_id, to_id: edge.to_id, relation: edge.relation }
                      : edge,
                  ),
                total: edges.length,
                nextOffset:
                  input.offset + input.limit < edges.length ? input.offset + input.limit : null,
              };
            }
          }
        },
        [],
        {},
        {
          add: {
            description: "Upsert an edge and return its stored record",
            positionals: [
              { name: "from", type: "string", required: true },
              { name: "to", type: "string", required: true },
              { name: "relation", type: "string", required: true },
            ],
            flags: {
              attributes: { type: "json", description: "Edge attribute object (default {})" },
            },
          },
          remove: {
            description:
              "Remove an exact edge and return its stored pre-delete record; fails if absent",
            positionals: [
              { name: "from", type: "string", required: true },
              { name: "to", type: "string", required: true },
              { name: "relation", type: "string", required: true },
            ],
          },
          list: {
            description:
              "List edge summaries, total and nextOffset (null when exhausted); pages are not snapshots",
            examples: ["bl edge list ID --limit 20"],
            positionals: [
              { name: "id", type: "string", description: "Incident node; omitted lists all edges" },
            ],
            flags: {
              relation: { type: "string", description: "Filter by exact relation" },
              limit: { type: "number", description: "Page size (default 20; 1–100)" },
              offset: { type: "number", description: "Continue at nextOffset (default 0)" },
              lean: {
                type: "boolean",
                description: "Summaries by default; --lean=false includes attributes",
              },
            },
          },
        },
      );
    },
  };
}

export default batteries();
