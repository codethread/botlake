import {
  jsonSchema,
  Fault,
  requireValue,
  defineOp,
  q,
  type Context,
  type Extension,
  type Node,
  type Predicate,
} from "@botlake/core";
import { attribute, callerActor, resolveIdentity } from "@botlake/extension-identity";
import { z } from "zod";

const authority = Symbol("diary");
const text = z.compile(z.string().trim().min(1));
const rawText = z.compile(z.string());
const limit = z.compile(z.number().int().positive().max(100).default(20));
const entryPredicate = q.eq(q.attr("diary/entry"), true);

export function diary(): Extension {
  return {
    name: "diary",
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
                Object.keys(record.attributes).some((key) => key.startsWith("diary/")),
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
            text: z
              .string()
              .refine((value) => value.trim().length > 0, "Entry text must not be blank"),
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
          about:
            "Each registered identity has an implicit diary across tasks. Add/list default to caller BL_ACTOR. List returns oldest-first previews; pass next as --after until null, then show an entry for full text. Pages are not a shared snapshot. Entries are immutable; corrections are new entries.",
          primer:
            "Record useful experiments, intermediate findings and working history selectively. Promote conclusions into the task's current summary at handoff/completion. A diary is optional, not an automatic transcript or automatically evidence for every task its author touched.",
          cli: {
            description: "Immutable identity diary entries",
            examples: [
              'bl diary add "Investigated boundary" --identity IDENTITY',
              "bl diary list IDENTITY --limit 20",
              "bl diary show ENTRY_ID",
            ],
            commands: {
              add: {
                description: "Add an immutable entry (identity defaults to BL_ACTOR)",
                positionals: [{ name: "text", type: "string", required: true }],
                flags: { identity: { type: "string" } },
              },
              list: {
                description: "List oldest entries (identity defaults to BL_ACTOR)",
                positionals: [{ name: "identity", type: "string" }],
                flags: {
                  after: { type: "string", description: "Continue after an entry" },
                  limit: { type: "number", description: "Page size (default 20, max 100)" },
                },
              },
              show: {
                description: "Show full entry",
                positionals: [{ name: "id", type: "string", required: true }],
              },
            },
          },
          handler(input) {
            switch (input.command) {
              case "add":
                return addEntry(ctx, input.text, input.identity);
              case "list":
                return listEntries(ctx, input.identity, input.after, input.limit);
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
  const identity = selectedIdentity(ctx, requestedIdentity);
  const owner = requireValue(resolveIdentity(ctx.graph, identity), "Unknown identity");
  const record = ctx.graph.atomic(() => {
    const created = ctx.graph.note(owner.id, body, {
      "diary/entry": true,
      "identity/by-identity": identity,
    });
    attribute(ctx, created.id, identity, "attributed");
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
  next: string | null;
} {
  const identity = selectedIdentity(ctx, requestedIdentity);
  requireValue(resolveIdentity(ctx.graph, identity), "Unknown identity");
  const predicates: [Predicate, ...Predicate[]] = [
    entryPredicate,
    q.eq(q.attr("identity/by-identity"), identity),
  ];

  if (after !== undefined) {
    const cursor = entry(ctx, after);
    if (cursor.attributes["identity/by-identity"] !== identity)
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
    lean: false,
  });
  const page = records.slice(0, pageSize);

  return {
    identity,
    entries: page.map((record) => ({
      id: record.id,
      at: entryAt(record),
      preview: rawText.parse(record.attributes["note/text"]).slice(0, 120),
    })),
    next: records.length > pageSize ? (page.at(-1)?.id ?? null) : null,
  };
}

function entry(ctx: Context, id: string): Node {
  const record = ctx.graph.show(id, false);
  if (record.attributes["diary/entry"] !== true) throw new Fault("diary", "Unknown diary entry");
  return record;
}

function presentEntry(record: Node): { id: string; identity: string; at: string; text: string } {
  return {
    id: record.id,
    identity: text.parse(record.attributes["identity/by-identity"]),
    at: entryAt(record),
    text: rawText.parse(record.attributes["note/text"]),
  };
}

function entryAt(record: Node): string {
  return text.parse(record.attributes["note/at"]);
}

function selectedIdentity(ctx: Context, explicit: string | undefined): string {
  return requireValue(explicit ?? callerActor(ctx), "Supply identity or BL_ACTOR");
}
