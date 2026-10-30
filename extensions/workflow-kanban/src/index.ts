import { defineOp, Fault, jsonSchema, type Extension } from "@botlake/core";
import { workflowRun } from "@botlake/extension-workflow";
import { z } from "zod";

const text = z.string().trim().min(1);
const input = z.compile(
  z.discriminatedUnion("command", [
    z.strictObject({ command: z.literal("attach"), card: text, run: text }),
    z.strictObject({ command: z.literal("show"), card: text }),
  ]),
);

/** Optional containment adapter; domains own progression and blockage independently. */
export function workflowKanban(): Extension {
  return {
    name: "workflow-kanban",
    requires: ["kanban", "workflow"],
    activate(ctx) {
      function card(id: string) {
        const row = ctx.graph.show(id);
        if (row.attributes["kanban/card"] !== true || row.attributes["kanban/link"] !== undefined)
          throw new Fault("workflow-kanban", "Expected a local Kanban card");
        return row;
      }
      function show(id: string) {
        const row = card(id);
        return jsonSchema.parse({
          card: id,
          lane: row.attributes["kanban/lane"] ?? null,
          progression: row.attributes["kanban/progression"] ?? "free",
          workflows: ctx.graph
            .edges(id, "parent-of")
            .filter((edge) => edge.from_id === id)
            .map((edge) => ctx.graph.show(edge.to_id))
            .filter((node) => node.attributes["workflow/root"] === true)
            .map((run) => ({ id: run.id, title: run.title, complete: run.state === "closed" })),
        });
      }
      ctx.register(
        defineOp({
          name: "workflow-kanban",
          input,
          output: jsonSchema,
          jsonSchema: { input, output: jsonSchema },
          primer:
            "A Kanban card owns business scope; each linked workflow root owns an authored process. Roots are contained work, not execution prerequisites, so the card can be claimed while workflows run. Opt the card into children progression to gate review and completion on every linked root. Finishing workflows does not automatically finish the card. Move a reviewed parent back before adding work. Each domain independently records and resolves operational blockages using the same graph protocol.",
          cli: {
            description: "Link independent workflow roots as Kanban child work",
            commands: {
              attach: {
                description: "Link an existing root to an active opted-in card",
                positionals: [
                  { name: "card", type: "string", required: true },
                  { name: "run", type: "string", required: true },
                ],
              },
              show: {
                description: "Show linked workflows and the card policy",
                positionals: [{ name: "card", type: "string", required: true }],
              },
            },
          },
          handler(value) {
            if (value.command === "show") return show(value.card);
            return ctx.graph.atomic(() => {
              const row = card(value.card);
              if (row.state !== "active" || row.attributes["kanban/progression"] !== "children")
                throw new Fault(
                  "workflow-kanban",
                  "Use an active card with --progression children",
                );
              workflowRun(ctx.graph, value.run);
              ctx.graph.connect(value.card, value.run, "parent-of");
              return show(value.card);
            });
          },
        }),
      );
    },
  };
}

export default workflowKanban();
