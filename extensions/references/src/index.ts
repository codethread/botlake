import { Fault, defineOp, q, type Extension, type Predicate } from "@botlake/core";

import {
  acknowledgementSchema,
  inputSchema,
  optionsSchema,
  outputSchema,
  summarySchema,
  type ReferenceOptions,
} from "./model.ts";
import { referenceSync } from "./sync.ts";

export type { ReferenceOptions, ReferenceProjection } from "./model.ts";

/** Explicitly select synchronization; importing this package neither follows nor activates a lake. */
export function references(options: ReferenceOptions = {}): Extension {
  const settings = optionsSchema.parse(options);
  const kinds = new Set<string>();
  for (const projection of settings.projections) {
    requireNodePredicate(projection.where);
    if (kinds.has(projection.kind))
      throw new Fault("reference-projection", `Duplicate projection kind: ${projection.kind}`);
    kinds.add(projection.kind);
  }
  return {
    name: "references",
    activate(ctx) {
      const sync = referenceSync(ctx, settings);
      ctx.resource(sync);
      ctx.register(
        defineOp({
          name: "reference",
          input: inputSchema,
          output: outputSchema,
          jsonSchema: { input: inputSchema, output: outputSchema },
          about:
            "References retain owner identity, revision and read-only core summaries outside attributes. Remote commands still run at their owner. A live source is eventually observed, not a shared transaction. Disconnection makes observations stale; a different owner at the same path never retargets them.",
          primer:
            "Add WORKSPACE NODE to obtain a local reference ID; connect it with ordinary edges or Work links. Work prerequisites require an explicitly configured Work projection and a current closed observation. list/status are paged; nextOffset=null means exhausted. refresh ID requests a covered observation; forget ID removes only the local reference and incident edges. Full details stay at the source. Use work diagnose TASK for cross-lake dependency cycles.",
          cli: {
            description: "Follow source-owned node summaries across independent lakes",
            examples: [
              "bl reference add OTHER_LAKE SOURCE_NODE",
              "bl work link TASK REFERENCE_ID --relation depends-on",
              "bl reference list",
              "bl reference refresh REFERENCE_ID",
            ],
            commands: {
              add: {
                description:
                  "Import one source-owned node; returns local ID, observed state and provenance",
                positionals: [
                  { name: "workspace", type: "string", required: true },
                  { name: "node", type: "string", required: true },
                ],
              },
              refresh: {
                description: "Refresh an existing reference under a live source subscription",
                positionals: [{ name: "id", type: "string", required: true }],
              },
              forget: {
                description: "Delete the local reference and incident edges; source unchanged",
                positionals: [{ name: "id", type: "string", required: true }],
              },
              list: {
                description: "Paged local summaries; no source attributes or remote calls",
                flags: {
                  "lake-id": {
                    key: "lakeId",
                    type: "string",
                    description: "Filter by durable owner lake UUID",
                  },
                  limit: { type: "number", description: "Page size 1–100, default 20" },
                  offset: { type: "number", description: "Continue at nextOffset" },
                },
              },
              status: {
                description: "Paged owner connectivity and actionable failures",
                flags: {
                  "lake-id": {
                    key: "lakeId",
                    type: "string",
                    description: "Filter by durable owner lake UUID",
                  },
                  limit: { type: "number", description: "Page size 1–100, default 20" },
                  offset: { type: "number", description: "Continue at nextOffset" },
                },
              },
              source: {
                description:
                  "Inspect this lake's persistent identity and explicit projection kinds",
              },
              snapshot: {
                description:
                  "Bounded synchronization summaries of owned nodes; no attributes or execution state",
                flags: {
                  ids: {
                    type: "json",
                    required: true,
                    description:
                      "JSON array of up to 100 local source node IDs; references are reported missing",
                  },
                },
              },
            },
          },
          async handler(input, _ctx, request) {
            switch (input.command) {
              case "source":
                return {
                  lakeId: ctx.graph.lakeId,
                  workspace: ctx.workspace,
                  projections: [...kinds],
                };
              case "snapshot": {
                const nodes = ctx.graph.snapshots(input.ids).map((node) => {
                  const matches = settings.projections.filter(
                    (projection) =>
                      ctx.graph.count({
                        where: q.and(q.eq("id", node.id), projection.where),
                        limit: 1,
                      }) > 0,
                  );
                  if (matches.length > 1)
                    throw new Fault(
                      "reference-projection",
                      "Source node matches multiple projection kinds",
                      { id: node.id, kinds: matches.map((match) => match.kind) },
                    );
                  return { ...node, kind: matches[0]?.kind ?? null };
                });
                const found = new Set(nodes.map((node) => node.id));
                return {
                  lakeId: ctx.graph.lakeId,
                  nodes,
                  missing: [...new Set(input.ids)].filter((id) => !found.has(id)),
                };
              }
              case "add": {
                const node = await sync.add(input.workspace, input.node, request.signal);
                return acknowledgementSchema.parse({
                  id: node.id,
                  state: node.state,
                  reference: node.reference,
                });
              }
              case "refresh": {
                const node = await sync.refresh(input.id, request.signal);
                return acknowledgementSchema.parse({
                  id: node.id,
                  state: node.state,
                  reference: node.reference,
                });
              }
              case "forget": {
                ctx.graph.forgetReference(input.id);
                return { id: input.id, forgotten: true as const };
              }
              case "list": {
                const page = ctx.graph.references({
                  ...(input.lakeId === undefined ? {} : { lakeId: input.lakeId }),
                  limit: input.limit,
                  offset: input.offset,
                });
                return {
                  ...page,
                  nodes: page.nodes.map(({ id, title, state, reference }) =>
                    summarySchema.parse({
                      id,
                      title,
                      state,
                      reference,
                    }),
                  ),
                };
              }
              case "status":
                return sync.status(input.lakeId, input.limit, input.offset);
            }
          },
        }),
      );
    },
  };
}

export default references();

// -- Private helpers --

function requireNodePredicate(predicate: Predicate): void {
  if (predicate.op === "edge")
    throw new Fault(
      "reference-projection",
      "Projection classifiers must use only source node fields and attributes",
    );
  if (predicate.op === "and" || predicate.op === "or") {
    for (const child of predicate.args) requireNodePredicate(child);
  } else if (predicate.op === "not") requireNodePredicate(predicate.arg);
  else if (
    "value" in predicate &&
    typeof predicate.value === "object" &&
    predicate.value !== null &&
    !Array.isArray(predicate.value) &&
    "param" in predicate.value
  )
    throw new Fault(
      "reference-projection",
      "Projection classifiers cannot require query parameters",
    );
}
