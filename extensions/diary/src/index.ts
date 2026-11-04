import {
  jsonSchema,
  Fault,
  requireValue,
  defineOp,
  q,
  noteAttributes,
  type Context,
  type Extension,
  type Node,
  type Predicate,
} from "@botlake/core";
import {
  attribute,
  identityRelations,
  identityAttributes,
  resolveIdentity,
} from "@botlake/extension-identity";
import { z } from "zod";

import { diaryAttributes, diaryNamespace } from "./node-model.ts";

export { diaryAttributes, diaryNamespace } from "./node-model.ts";

const authority = Symbol("diary");
const text = z.compile(z.string().trim().min(1));
const rawText = z.compile(z.string());
const limit = z.compile(z.number().int().positive().max(100).default(20));
const entryPredicate = q.eq(q.attr(diaryAttributes.entry), true);

export function diary(): Extension {
  return {
    name: "diary",
    source: import.meta.url,
    requires: ["identity"],
    activate(ctx) {
      ctx.graph.protect((changes, token) => {
        if (token === authority) return;

        for (const change of changes) {
          if (change.kind === "node") {
            const records = [change.before, change.after].filter(
              (record): record is Node => record !== null,
            );
            if (
              records.some((record) =>
                Object.keys(record.attributes).some((key) => key.startsWith(diaryNamespace)),
              )
            )
              throw new Fault("diary-guard", "Diary entries require the Diary API");
          } else {
            const edge = change.before ?? change.after;
            if (
              edge !== null &&
              ctx.graph.list({
                where: q.and(entryPredicate, q.inArray("id", [edge.from_id, edge.to_id])),
                limit: 1,
              }).length > 0
            )
              throw new Fault("diary-guard", "Diary provenance is immutable");
          }
        }
      });

      const commandSchema = z.compile(
        z.discriminatedUnion("command", [
          z.strictObject({
            command: z.literal("add"),
            text: z.string().regex(/\S/u, "Entry text must not be blank"),
            identity: text.optional(),
          }),
          z.strictObject({
            command: z.literal("list"),
            identity: text.optional(),
            after: text.optional(),
            limit,
          }),
          z.strictObject({ command: z.literal("show"), id: text }),
        ]),
      );
      ctx.register(
        defineOp({
          name: "diary",
          input: commandSchema,
          output: jsonSchema,
          jsonSchema: { input: commandSchema, output: jsonSchema },
          about:
            "Each registered identity has an implicit diary across tasks. Add/list default to the invocation caller. List returns oldest-first previews; pass nextCursor as --after until null, then show an entry for full text. Pages are not a shared snapshot. Entries are immutable; corrections are new entries.",
          primer:
            "Record useful experiments, intermediate findings and working history selectively. Promote conclusions into the task's current summary at handoff/completion. A diary is optional, not an automatic transcript or automatically evidence for every task its author touched.",
          cli: {
            description: "Immutable working notes owned by native identity",
            examples: [
              'bl diary add "Investigated boundary"',
              "bl diary list --limit 20",
              "bl diary list IDENTITY --after ENTRY_ID",
              "bl diary show ENTRY_ID",
            ],
            commands: {
              add: {
                description: "Add nonblank immutable text; returns entry id, identity and time",
                examples: [
                  'bl diary add "Investigated boundary"',
                  'bl diary add "Result belongs to reviewer" --identity IDENTITY',
                ],
                positionals: [{ name: "text", type: "string", required: true }],
                flags: {
                  identity: {
                    type: "string",
                    description: "Registered identity (defaults to the invocation caller)",
                  },
                },
              },
              list: {
                description:
                  "List oldest-first entries (id, at, preview); long previews are truncated. Continue at nextCursor via --after",
                examples: [
                  "bl diary list",
                  "bl diary list IDENTITY --limit 20",
                  "bl diary list IDENTITY --after ENTRY_ID",
                ],
                positionals: [
                  {
                    name: "identity",
                    type: "string",
                    description: "Optional registered identity (defaults to the invocation caller)",
                  },
                ],
                flags: {
                  after: {
                    type: "string",
                    description: "Entry ID cursor from prior nextCursor; omit for first page",
                  },
                  limit: { type: "number", description: "Page size (default 20; range 1–100)" },
                },
              },
              show: {
                description: "Show one full entry, including its text",
                examples: ["bl diary show ENTRY_ID"],
                positionals: [{ name: "id", type: "string", required: true }],
              },
            },
          },
          handler(input, _ctx, invocation) {
            switch (input.command) {
              case "add":
                return addEntry(
                  ctx,
                  input.text,
                  input.identity ?? invocation.identity ?? undefined,
                );
              case "list":
                return listEntries(
                  ctx,
                  input.identity ?? invocation.identity ?? undefined,
                  input.after,
                  input.limit,
                );
              case "show":
                return presentEntry(entry(ctx, input.id));
            }
          },
        }),
      );
    },
  };
}

export default diary();

// -- Private helpers --

function addEntry(
  ctx: Context,
  body: string,
  requestedIdentity: string | undefined,
): { id: string; identity: string; at: string } {
  const identity = selectedIdentity(requestedIdentity);
  const owner = requireValue(resolveIdentity(ctx.graph, identity), "Unknown identity");
  const record = ctx.graph.atomic(() => {
    const created = ctx.graph.note(owner.id, body, {
      [diaryAttributes.entry]: true,
      [identityAttributes.byIdentity]: identity,
    });
    attribute(ctx, created.id, identity, identityRelations.attributed);
    return created;
  }, authority);

  return { id: record.id, identity, at: entryAt(record) };
}

function listEntries(
  ctx: Context,
  requestedIdentity: string | undefined,
  after: string | undefined,
  pageSize: number,
): {
  identity: string;
  entries: { id: string; at: string; preview: string }[];
  nextCursor: string | null;
} {
  const identity = selectedIdentity(requestedIdentity);
  requireValue(resolveIdentity(ctx.graph, identity), "Unknown identity");
  const predicates: [Predicate, ...Predicate[]] = [
    entryPredicate,
    q.eq(q.attr(identityAttributes.byIdentity), identity),
  ];

  if (after !== undefined) {
    const cursor = entry(ctx, after);
    if (cursor.attributes[identityAttributes.byIdentity] !== identity)
      throw new Fault("diary-cursor", "Cursor belongs to another identity");
    predicates.push(
      q.or(
        q.gt("created_at", cursor.created_at),
        q.and(q.eq("created_at", cursor.created_at), q.gt("id", cursor.id)),
      ),
    );
  }

  const records = ctx.graph.list({
    where: q.and(...predicates),
    limit: pageSize + 1,
    includeArchived: true,
  });
  const page = records.slice(0, pageSize);

  return {
    identity,
    entries: page.map((record) => ({
      id: record.id,
      at: entryAt(record),
      preview: rawText.parse(record.attributes[noteAttributes.text]).slice(0, 120),
    })),
    nextCursor: records.length > pageSize ? (page.at(-1)?.id ?? null) : null,
  };
}

function entry(ctx: Context, id: string): Node {
  const record = ctx.graph.show(id, { includeArchived: true });
  if (record.attributes[diaryAttributes.entry] !== true)
    throw new Fault("diary", "Unknown diary entry");
  return record;
}

function presentEntry(record: Node): { id: string; identity: string; at: string; text: string } {
  return {
    id: record.id,
    identity: text.parse(record.attributes[identityAttributes.byIdentity]),
    at: entryAt(record),
    text: rawText.parse(record.attributes[noteAttributes.text]),
  };
}

function entryAt(record: Node): string {
  return text.parse(record.attributes[noteAttributes.at]);
}

function selectedIdentity(explicit: string | undefined): string {
  return requireValue(explicit, "Supply identity or caller identity");
}
