import {
  attributesSchema,
  defineOp,
  Fault,
  jsonSchema,
  nodeSchema,
  predicateSchema,
  type Context,
  type Node,
} from "@botlake/core";
import { z } from "zod";

const id = z.string().min(1);
const patch = {
  title: id.optional(),
  state: nodeSchema.shape.state.exclude(["replaced"]).optional(),
  attributes: attributesSchema.optional(),
  expectedRevision: z.number().int().positive().optional(),
};
const readOptions = {
  lean: z.boolean().default(false),
  includeArchived: z.boolean().default(false),
};
const readFlags = {
  lean: { type: "boolean", description: "Return only id, title and state for each node" },
  "include-archived": {
    key: "includeArchived",
    type: "boolean",
    description: "Include archived attributes; omitted by default",
  },
} as const;
const selection = {
  query: z.string().optional(),
  where: predicateSchema.optional(),
  params: attributesSchema.optional(),
  limit: z.number().int().positive().optional(),
  ...readOptions,
};

const inputSchema = z.compile(
  z.discriminatedUnion("command", [
    z.strictObject({
      command: z.literal("add"),
      title: id,
      state: nodeSchema.shape.state.exclude(["replaced"]).optional(),
      attributes: attributesSchema.optional(),
    }),
    z.strictObject({ command: z.literal("show"), id, ...readOptions }),
    z.strictObject({ command: z.literal("update"), id, ...patch }),
    z.strictObject({
      command: z.literal("set-attributes"),
      id,
      attributes: attributesSchema,
      expectedRevision: patch.expectedRevision,
    }),
    z.strictObject({ command: z.literal("list"), ...selection }),
    z.strictObject({ command: z.literal("ready"), ...selection }),
    z.strictObject({ command: z.literal("supersede"), id, replacement: id }),
    z.strictObject({ command: z.literal("burn"), ids: z.array(id).min(1) }),
    z.strictObject({
      command: z.literal("note"),
      id,
      text: id,
      attributes: attributesSchema.optional(),
    }),
    z.strictObject({ command: z.literal("archive"), id, keys: z.array(id).min(1) }),
    z.strictObject({ command: z.literal("subgraph"), id, relation: id.optional(), ...readOptions }),
  ]),
);

type NodeInput = z.output<typeof inputSchema>;

export function registerNode(ctx: Context): void {
  ctx.register(
    defineOp({
      name: "node",
      input: inputSchema,
      output: jsonSchema,
      jsonSchema: { input: inputSchema, output: jsonSchema },
      primer:
        "Create, inspect, select and mutate graph nodes. Update applies recursive merge patches (null deletes keys); set-attributes replaces supplied values exactly, including nested objects and nulls. Omitted top-level keys stay unchanged in both operations.",
      cli: {
        description: "Create, inspect, select and mutate graph nodes",
        examples: [
          'bl node add "Investigate issue" --attributes \'{"priority":"p2"}\'',
          "bl node list --limit 20",
          'bl node update ID --attributes \'{"priority":"p1"}\'',
          'bl node set-attributes ID --attributes \'{"context":{"answer":null}}\'',
        ],
        commands: {
          add: {
            description: "Create a node, then use its returned id for notes, edges and updates",
            examples: ['bl node add "Investigate issue" --attributes \'{"priority":"p2"}\''],
            positionals: [{ name: "title", type: "string", required: true }],
            flags: { state: { type: "string" }, attributes: { type: "json" } },
          },
          show: {
            description:
              "Read a node with hot attributes; --include-archived adds archived values, --lean returns only id, title and state",
            examples: ["bl node show ID"],
            positionals: [{ name: "id", type: "string", required: true }],
            flags: readFlags,
          },
          update: {
            description:
              "Merge-patch a node; objects merge recursively, null deletes keys, and omitted keys stay unchanged. Use --expected-revision to reject stale writes.",
            examples: [
              'bl node update ID --expected-revision 2 --attributes \'{"priority":"p1"}\'',
            ],
            positionals: [{ name: "id", type: "string", required: true }],
            flags: {
              title: { type: "string" },
              state: { type: "string" },
              attributes: {
                type: "json",
                description: "Recursive merge patch; null deletes keys",
              },
              "expected-revision": {
                key: "expectedRevision",
                type: "number",
                description: "Reject changes since this revision",
              },
            },
          },
          "set-attributes": {
            description:
              "Replace supplied values exactly, including nested objects and nulls; omitted keys stay unchanged. Use update for merge patches or key deletion.",
            examples: ['bl node set-attributes ID --attributes \'{"context":{"answer":null}}\''],
            positionals: [{ name: "id", type: "string", required: true }],
            flags: {
              attributes: {
                type: "json",
                required: true,
                description:
                  "Exact values; nested objects and nulls are preserved, omitted keys stay unchanged",
              },
              "expected-revision": {
                key: "expectedRevision",
                type: "number",
                description: "Reject changes since this revision",
              },
            },
          },
          list: {
            description:
              "Select nodes with a named query (--query and --params) or an ad hoc predicate through lake eval and api.call('node', {command: 'list', where, params, limit}). Default limit is 100; a full page does not prove completeness, and archived values do not participate in hot selection.",
            examples: ["bl node list --limit 20"],
            flags: {
              query: { type: "string", description: "Registered query name" },
              params: { type: "json", description: "Named-query parameters" },
              limit: { type: "number", description: "Maximum results; defaults to 100" },
              ...readFlags,
            },
          },
          ready: {
            description:
              "Select active nodes with no active depends-on targets; use --query and --params or lake eval with api.call('node', {command: 'ready', where, params, limit}). Default limit is 100; a full page does not prove completeness.",
            examples: ["bl node ready --limit 20"],
            flags: {
              query: { type: "string", description: "Registered query name" },
              params: { type: "json", description: "Named-query parameters" },
              limit: { type: "number", description: "Maximum results; defaults to 100" },
              ...readFlags,
            },
          },
          supersede: {
            description:
              "Create the replacement first; marks the original replaced, preserves dependency attributes, and rejects cycles or an already-replaced original",
            examples: ["bl node supersede OLD_ID NEW_ID"],
            positionals: [
              { name: "id", type: "string", required: true },
              { name: "replacement", type: "string", required: true },
            ],
          },
          burn: {
            description:
              "Delete nodes and incident edges while retaining tombstones; domain guards can reject protected evidence",
            examples: ["bl node burn ID"],
            positionals: [{ name: "ids", type: "string", multiple: true, required: true }],
          },
          note: {
            description:
              "Attach an immutable note node connected by a notes edge; text and timestamp cannot change. Use --stdin and :stdin for multiline text.",
            examples: ["printf 'Investigation notes' | bl --stdin node note ID :stdin"],
            positionals: [
              { name: "id", type: "string", required: true },
              { name: "text", type: "string", required: true },
            ],
            flags: { attributes: { type: "json" } },
          },
          archive: {
            description:
              "Hide keys from hot selection without deleting them; read retained values with --include-archived. Immutable note keys cannot be archived",
            examples: ["bl node archive ID KEY"],
            positionals: [
              { name: "id", type: "string", required: true },
              { name: "keys", type: "string", multiple: true, required: true },
            ],
          },
          subgraph: {
            description:
              "Follow outgoing edges (parent-of by default) and include all edges between selected nodes",
            examples: ["bl node subgraph ID --relation parent-of"],
            positionals: [{ name: "id", type: "string", required: true }],
            flags: {
              relation: { type: "string", description: "Traversal relation (default parent-of)" },
              ...readFlags,
            },
          },
        },
      },
      handler(input, context) {
        return jsonSchema.parse(handleNode(input, context));
      },
    }),
  );
}

// -- Private helpers --

function handleNode(input: NodeInput, ctx: Context): unknown {
  switch (input.command) {
    case "add": {
      const { command: _, ...node } = input;
      return ctx.graph.add(node);
    }
    case "show":
      return nodeView(
        ctx.graph.show(input.id, { includeArchived: input.includeArchived }),
        input.lean,
      );
    case "update": {
      const { command: _, id: node, ...changes } = input;
      return ctx.graph.update(node, changes);
    }
    case "set-attributes":
      return ctx.graph.setAttributes(input.id, input.attributes, input.expectedRevision);
    case "list":
    case "ready": {
      const { command, lean, ...options } = input;
      let where = options.where;
      if (options.query !== undefined) {
        const named = ctx.namedQuery(options.query);
        if (named === undefined) throw new Fault("query", `Unknown query: ${options.query}`);

        if (where !== undefined) throw new Fault("query", "Choose named or ad hoc query");

        for (const param of named.params ?? [])
          if (options.params?.[param] === undefined)
            throw new Fault("query", `Missing parameter: ${param}`);
        where = named.where;
      }
      return ctx.graph
        .list({ ...options, where, ready: command === "ready" })
        .map((node) => nodeView(node, lean));
    }
    case "supersede":
      return ctx.graph.supersede(input.id, input.replacement);
    case "burn":
      return ctx.graph.burn(input.ids);
    case "note":
      return ctx.graph.note(input.id, input.text, input.attributes);
    case "archive":
      return ctx.graph.archive(input.id, input.keys);
    case "subgraph": {
      const subgraph = ctx.graph.subgraph(input.id, input.relation, {
        includeArchived: input.includeArchived,
      });
      return { ...subgraph, nodes: subgraph.nodes.map((node) => nodeView(node, input.lean)) };
    }
  }
}

function nodeView(node: Node, lean: boolean): Node | Pick<Node, "id" | "title" | "state"> {
  return lean ? { id: node.id, title: node.title, state: node.state } : node;
}
