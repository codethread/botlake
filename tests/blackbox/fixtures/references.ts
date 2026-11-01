import { realpath } from "node:fs/promises";
import { join } from "node:path";

import type { system } from "./system.ts";

/** Test consumer of the typed library; management commands are not production operations. */
export const referenceFixtureModule = `import { defineOp, jsonSchema } from "@botlake/core";
import { z } from "zod";
import refs from "./references.ts";
const page = { lakeId: z.string().optional(), limit: z.number().optional(), offset: z.number().optional() };
const input = z.discriminatedUnion("command", [
  z.strictObject({ command: z.literal("add"), workspace: z.string(), node: z.string() }),
  z.strictObject({ command: z.literal("refresh"), id: z.string() }),
  z.strictObject({ command: z.literal("forget"), id: z.string() }),
  z.strictObject({ command: z.literal("list"), ...page }),
  z.strictObject({ command: z.literal("status"), ...page }),
]);
export default { name: "reference-fixture", requires: [refs.name], activate(ctx) {
  const references = refs.get(ctx);
  ctx.register(defineOp({ name: "reference-fixture", input, output: jsonSchema,
    cli: { description: "Exercise the reference library through a test consumer" },
    async handler(input, _ctx, request) {
      switch(input.command) {
        case "add": {
          const node = await references.follow({ workspace: input.workspace, nodeId: input.node }, request.signal);
          return { id: node.id, state: node.state, reference: node.reference };
        }
        case "refresh": {
          const node = await references.refresh(input.id, request.signal);
          return { id: node.id, state: node.state, reference: node.reference };
        }
        case "forget": references.forget(input.id); return { id: input.id, forgotten: true };
        case "list": { const { command, ...options } = input; return references.list(options); }
        case "status": { const { command, ...options } = input; return references.status(options); }
      }
    }
  }));
}};`;

export async function referenceBoard(host: Awaited<ReturnType<typeof system>>, name: string) {
  const workspace = await host.workspace(name, [
    "@botlake/extension-batteries",
    "@botlake/extension-identity",
    "./references.ts",
    "./work.ts",
    "./reference-fixture.ts",
  ]);
  await Bun.write(
    join(workspace, "references.ts"),
    `import { references } from "@botlake/extension-references";
import { workReferenceProjections } from "@botlake/extension-work";
export default references({ projections: workReferenceProjections });`,
  );
  await Bun.write(
    join(workspace, "work.ts"),
    `import { work } from "@botlake/extension-work";
import references from "./references.ts";
export default work({ references });`,
  );
  await Bun.write(join(workspace, "reference-fixture.ts"), referenceFixtureModule);
  return realpath(workspace);
}
