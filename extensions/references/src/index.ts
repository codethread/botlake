import { Fault, defineOp, q, type Context, type Predicate } from "@botlake/core";

import {
  inputSchema,
  optionsSchema,
  outputSchema,
  pageOptionsSchema,
  summarySchema,
  type ReferenceLibrary,
  type ReferenceOptions,
  type References,
} from "./model.ts";
import { referenceSync } from "./sync.ts";

export type {
  ReferenceAddress,
  ReferenceLibrary,
  ReferenceOptions,
  ReferencePage,
  ReferencePageOptions,
  ReferenceProjection,
  References,
  ReferenceStatusPage,
} from "./model.ts";

/** Configure once, explicitly select, then inject the same binding into domain extensions. */
export function references(options: ReferenceOptions = {}): ReferenceLibrary {
  const settings = optionsSchema.parse(options);
  const kinds = new Set<string>();
  const instances = new WeakMap<Context, References>();
  for (const projection of settings.projections) {
    requireNodePredicate(projection.where);
    if (kinds.has(projection.kind))
      throw new Fault("reference-projection", `Duplicate projection kind: ${projection.kind}`);
    kinds.add(projection.kind);
  }
  return {
    name: "references",
    source: import.meta.url,
    get(ctx) {
      const instance = instances.get(ctx);
      if (instance === undefined)
        throw new Fault(
          "reference-library",
          "Select the configured reference library before its consumers",
        );
      return instance;
    },
    activate(ctx) {
      const sync = referenceSync(ctx, settings);
      ctx.resource(sync);
      instances.set(ctx, {
        follow: (source, signal, selection) =>
          sync.add(source.workspace, source.nodeId, signal, selection?.kinds),
        lookup: (source, signal) => sync.lookup(source, signal),
        refresh: (id, signal) => sync.refresh(id, signal),
        forget: (id) => {
          ctx.graph.forgetReference(id);
        },
        list(selection = {}) {
          const input = pageOptionsSchema.parse(selection);
          const page = ctx.graph.references({
            limit: input.limit,
            offset: input.offset,
            ...(input.lakeId === undefined ? {} : { lakeId: input.lakeId }),
          });
          return {
            ...page,
            nodes: page.nodes.map(({ id, title, state, reference }) =>
              summarySchema.parse({ id, title, state, reference }),
            ),
          };
        },
        status(selection = {}) {
          const input = pageOptionsSchema.parse(selection);
          return sync.status(input.lakeId, input.limit, input.offset);
        },
      });
      ctx.register(
        defineOp({
          name: "references",
          input: inputSchema,
          output: outputSchema,
          async handler(input) {
            if (input.command === "source")
              return {
                lakeId: ctx.graph.lakeId,
                workspace: ctx.workspace,
                projections: [...kinds],
              };
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
                  {
                    id: node.id,
                    kinds: matches.map((match) => match.kind),
                  },
                );
              return { ...node, kind: matches[0]?.kind ?? null };
            });
            const found = new Set(nodes.map((node) => node.id));
            return {
              lakeId: ctx.graph.lakeId,
              nodes,
              missing: [...new Set(input.ids)].filter((id) => !found.has(id)),
            };
          },
        }),
      );
    },
  };
}

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
