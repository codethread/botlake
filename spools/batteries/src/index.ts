import {
  attributesSchema,
  Fault,
  predicateSchema,
  batchSchema,
  defineOp,
  type NamedQuery,
  type Command,
  type Context,
  type Spool,
} from "@millstrand/core";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { z } from "zod";

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
const guidance = {
  add: {
    description: "Create a strand with a title and attributes",
    primer: "Create a strand, then use its returned id for notes, edges and updates.",
    examples: ['strand add "Investigate issue" --attributes \'{"priority":"p2"}\''],
  },
  show: {
    description: "Read a strand and its attributes",
    primer:
      "Point reads include archived attributes. Use --lean to see only hot attributes; retain the revision for guarded updates.",
    examples: ["strand show ID"],
  },
  update: {
    description: "Patch a strand with optional revision checking",
    primer:
      "Omitted attributes stay unchanged; null deletes a key. Read the current revision and pass --expected-revision when a stale write must fail.",
    examples: ['strand update ID --expected-revision 2 --attributes \'{"priority":"p1"}\''],
  },
  list: {
    description: "Select strands, optionally with a named query",
    primer:
      "Use --query NAME and --params JSON for named queries. For ad hoc predicates and composition use mill weaver eval with q and api.call('list', {where, params, limit}). The default limit is 100; a full page does not prove completeness. Archived values do not participate in hot selection.",
    examples: ["strand list --limit 20"],
  },
  ready: {
    description: "Select active strands whose dependencies are satisfied",
    primer:
      "An active strand is ready when no outgoing depends-on target remains active. Use --query NAME and --params JSON, or mill weaver eval with api.call('ready', {where, params, limit}) for ad hoc predicates. The default limit is 100; a full page does not prove completeness.",
    examples: ["strand ready --limit 20"],
  },
  query: {
    description: "Inspect registered query definitions",
    primer:
      "List query names, inspect a definition and its parameters, then use it with list or ready.",
    examples: ["strand query", "strand query NAME"],
  },
  batch: {
    description: "Apply strand and edge mutations atomically",
    primer:
      "Bind durable ids in refs; name new strands with local refs. Supply ordered edge operations and optional expectedRevision values. Any failure rolls back the entire batch.",
    examples: ["strand --input @batch.json batch"],
  },
  supersede: {
    description: "Replace a strand and retarget its dependents",
    primer:
      "Create the replacement first. Supersession marks the original replaced, preserves dependency attributes and rejects cycles or an already-replaced original.",
    examples: ["strand supersede OLD_ID NEW_ID"],
  },
  burn: {
    description: "Delete strands and incident edges, retaining tombstones",
    primer:
      "Burn removes live records and records their snapshots. Domain guards can reject deletion of protected evidence.",
    examples: ["strand burn ID"],
  },
  note: {
    description: "Attach an immutable note to a strand",
    primer:
      "Notes are closed strands connected by notes edges. Their text and timestamp are immutable. Use --stdin and :stdin for multiline text.",
    examples: ["printf 'Investigation notes' | strand --stdin note ID :stdin"],
  },
  archive: {
    description: "Hide attributes from hot selection without deleting them",
    primer:
      "Archived keys remain visible on full point reads. Immutable note keys cannot be archived.",
    examples: ["strand archive ID KEY"],
  },
  subgraph: {
    description: "Read a strand and descendants along a named relation",
    primer:
      "Traversal follows outgoing edges, using parent-of by default. The result includes all edges between selected strands.",
    examples: ["strand subgraph ID --relation parent-of"],
  },
  edge: {
    description: "Add, remove or inspect named graph edges",
    primer:
      "Edges point from a source to a target. depends-on points from dependent to prerequisite; parent-of points from parent to child. Declared acyclic relations reject cycles; serves allows one target per source.",
    examples: ["strand edge add TASK_ID PREREQUISITE_ID depends-on", "strand edge list ID"],
  },
};
export function batteries(queries: Record<string, NamedQuery> = {}): Spool {
  return {
    name: "batteries",
    activate(ctx) {
      for (const [name, query] of Object.entries(queries)) ctx.registerQuery(name, query);
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
            output: z.json(),
            primer: guidance[name].primer,
            cli: {
              description: guidance[name].description,
              examples: guidance[name].examples,
              ...(commands === undefined ? { positionals, flags } : { commands }),
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
          "expected-revision": {
            key: "expectedRevision",
            type: "number",
            description: "Reject changes since this revision",
          },
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
        z.strictObject({ id, keys: z.array(id).min(1) }),
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
        { relation: { type: "string", description: "Traversal relation (default parent-of)" } },
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

export default batteries();
