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
  lean: {
    type: "boolean",
    description: "Return id, title, state and source metadata for references",
  },
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
  limit: z.number().int().min(1).max(10000).default(100),
  offset: z.number().int().nonnegative().default(0),
  ...readOptions,
  lean: z.boolean().default(true),
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
      about:
        "Nodes are graph records with hot and archived attributes. Read-only references expose source metadata separately from attributes; change their facts in the owning lake. Domain extensions own their protocols and guard protected data; changing a generic node state does not submit a workflow outcome.",
      primer:
        "Create, inspect, select and mutate graph nodes. List/ready return summary pages; follow nextOffset until null, and use show ID for attributes or --lean=false to expand page records. Pages are not snapshots. Named queries come from query NAME; ad hoc predicates use --input or botlake lake eval. Archived values do not participate in selection. Update merges objects recursively and null deletes keys; set-attributes preserves supplied values exactly. Omitted keys stay unchanged in both.",
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
            flags: {
              state: { type: "string", description: "active (default) or closed" },
              attributes: { type: "json", description: "Initial attribute object (default {})" },
            },
          },
          show: {
            description:
              "Read a node with hot attributes; --include-archived adds archived values, --lean retains id, title, state and reference provenance",
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
              state: { type: "string", description: "active or closed; omitted stays unchanged" },
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
              "List summary nodes, total and nextOffset (null when exhausted); all states by default. Use show ID for details.",
            examples: ["bl node list --limit 20"],
            flags: {
              query: { type: "string", description: "Registered query name" },
              params: { type: "json", description: "Query parameters (default {})" },
              limit: { type: "number", description: "Page size (default 100; 1–10000)" },
              offset: { type: "number", description: "Continue at nextOffset (default 0)" },
              ...readFlags,
              "include-archived": {
                ...readFlags["include-archived"],
                description:
                  "Include archived attributes in expanded records; requires --lean=false",
              },
              lean: {
                type: "boolean",
                description: "Summaries by default; --lean=false includes attributes",
              },
            },
          },
          ready: {
            description:
              "List locally owned active nodes with no active or unverified depends-on targets; returns nodes, total and nextOffset (null when exhausted).",
            examples: ["bl node ready --limit 20"],
            flags: {
              query: { type: "string", description: "Registered query name" },
              params: { type: "json", description: "Query parameters (default {})" },
              limit: { type: "number", description: "Page size (default 100; 1–10000)" },
              offset: { type: "number", description: "Continue at nextOffset (default 0)" },
              ...readFlags,
              "include-archived": {
                ...readFlags["include-archived"],
                description:
                  "Include archived attributes in expanded records; requires --lean=false",
              },
              lean: {
                type: "boolean",
                description: "Summaries by default; --lean=false includes attributes",
              },
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
              "Delete owned nodes and incident edges while retaining tombstones; use reference forget for imported nodes; domain guards can reject protected evidence",
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
      const selected = { ...options, where, ready: command === "ready" };
      const nodes = ctx.graph.list(selected).map((node) => nodeView(node, lean));
      const total = ctx.graph.count({ where, params: options.params, ready: selected.ready });
      return {
        nodes,
        total,
        nextOffset: options.offset + nodes.length < total ? options.offset + nodes.length : null,
      };
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

function nodeView(
  node: Node,
  lean: boolean,
): Node | (Pick<Node, "id" | "title" | "state"> & Partial<Pick<Node, "reference">>) {
  return lean
    ? {
        id: node.id,
        title: node.title,
        state: node.state,
        ...(node.reference === null ? {} : { reference: node.reference }),
      }
    : node;
}
