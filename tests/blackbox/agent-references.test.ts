import { test, expect } from "bun:test";
import { realpath } from "node:fs/promises";
import { join } from "node:path";

import { agentAttributes } from "@botlake/extension-agents";
import { z } from "zod";

import { system } from "./fixtures/system.ts";

type Host = Awaited<ReturnType<typeof system>>;

const identifier = z.object({ id: z.string() });
const followedRun = z.strictObject({
  id: z.string(),
  title: z.string(),
  state: z.enum(["active", "closed", "replaced"]),
  reference: z.strictObject({
    lakeId: z.uuid(),
    workspace: z.string(),
    nodeId: z.string(),
    revision: z.number(),
    observedAt: z.number(),
    status: z.enum(["current", "stale", "missing"]),
    kind: z.literal("agent/run"),
  }),
});
const errorResponse = z.object({ code: z.string(), message: z.string() });
const nodes = z.object({ total: z.number() });

test("Agents follows source-verified remote runs through its injected library without local execution or source payloads", async () => {
  const host = await system();
  try {
    const owner = await board(host, "agent-owner", true);
    const consumer = await board(host, "agent-consumer", true);
    const local = await board(host, "agent-local", false);
    for (const workspace of [owner, consumer, local])
      await host.botlake(["lake", "start", "--workspace", workspace]);

    const privatePrompt = "source-only-agent-instructions-".repeat(2000);
    const sourceRun = identifier.parse(
      await host.bl(owner, "agent", {
        command: "start",
        seat: "fixture",
        cwd: owner,
        prompt: privatePrompt,
      }),
    );
    const source = z
      .object({ attributes: z.record(z.string(), z.json()) })
      .parse(await host.bl(owner, "agent", { command: "show", id: sourceRun.id }));
    expect(source.attributes[agentAttributes.prompt]).toBe(privatePrompt);
    expect(source.attributes[agentAttributes.settled]).toBe(true);

    const imported = followedRun.parse(
      await host.cli([
        "--workspace",
        consumer,
        "agent",
        "follow",
        sourceRun.id,
        "--from-workspace",
        owner,
      ]),
    );
    expect(imported.reference).toMatchObject({
      workspace: owner,
      nodeId: sourceRun.id,
      status: "current",
      kind: "agent/run",
    });
    expect(Buffer.byteLength(JSON.stringify(imported))).toBeLessThan(700);
    expect(
      followedRun.parse(
        await host.bl(consumer, "agent", {
          command: "follow",
          id: sourceRun.id,
          fromWorkspace: owner,
        }),
      ).id,
    ).toBe(imported.id);
    const detail = z
      .object({ attributes: z.record(z.string(), z.json()), reference: z.json() })
      .parse(await host.bl(consumer, "agent", { command: "show", id: imported.id }));
    expect(detail.attributes).toEqual({});
    expect(detail.reference).toMatchObject({
      lakeId: imported.reference.lakeId,
      workspace: owner,
      nodeId: sourceRun.id,
      status: "current",
      kind: "agent/run",
    });
    expect(JSON.stringify(detail)).not.toContain(privatePrompt);
    expect(await host.bl(consumer, "agent", { command: "list" })).toEqual({
      runs: [],
      total: 0,
      nextOffset: null,
    });
    expect(
      z.object({ total: z.number() }).parse(await host.bl(owner, "agent", { command: "list" }))
        .total,
    ).toBe(1);

    const task = identifier.parse(
      await host.bl(owner, "work", { command: "create", title: "Source task" }),
    );
    const artifact = identifier.parse(
      await host.bl(owner, "node", { command: "add", title: "Source artifact" }),
    );
    const before = nodes.parse(await host.bl(consumer, "node", { command: "list" }));
    for (const id of [task.id, artifact.id])
      expect(
        await failure(host, consumer, { command: "follow", id, fromWorkspace: owner }),
      ).toMatchObject({ code: "reference-kind" });
    expect(nodes.parse(await host.bl(consumer, "node", { command: "list" })).total).toBe(
      before.total,
    );
    expect(
      await failure(host, local, {
        command: "follow",
        id: sourceRun.id,
        fromWorkspace: owner,
      }),
    ).toMatchObject({ code: "reference-library" });
    expect(await failure(host, consumer, { command: "cancel", id: imported.id })).toMatchObject({
      code: "run",
    });
    expect(
      z
        .object({ attributes: z.record(z.string(), z.json()) })
        .parse(await host.bl(owner, "agent", { command: "show", id: sourceRun.id })).attributes[
        agentAttributes.prompt
      ],
    ).toBe(privatePrompt);
  } finally {
    await host.close();
  }
}, 60000);

async function board(host: Host, name: string, withReferences: boolean): Promise<string> {
  const workspace = await host.workspace(name, [
    "@botlake/extension-batteries",
    "@botlake/extension-identity",
    "@botlake/extension-work",
    "./flags.ts",
    ...(withReferences ? ["./references.ts"] : []),
    "./agents.ts",
  ]);
  await Bun.write(
    join(workspace, "flags.ts"),
    `import { agentFlags } from "@botlake/extension-agents";
import { configureFlags } from "@botlake/extension-flags";
export default configureFlags([[agentFlags.codex, true]]);`,
  );
  if (withReferences)
    await Bun.write(
      join(workspace, "references.ts"),
      `import { references } from "@botlake/extension-references";
import { agentReferenceProjections } from "@botlake/extension-agents";
import { workReferenceProjections } from "@botlake/extension-work";
export default references({projections:[...agentReferenceProjections,...workReferenceProjections]});`,
    );
  await Bun.write(
    join(workspace, "agents.ts"),
    `import { agents, builtinProviders, agentFlags } from "@botlake/extension-agents";
${withReferences ? 'import references from "./references.ts";' : ""}
const base=builtinProviders.codex({flag:agentFlags.codex});
export default agents({${withReferences ? "references," : ""}providers:[{...base,prepare(){throw new Error("fixture has no process");}}],aliases:{fixture:{provider:"codex"}}});`,
  );
  return realpath(workspace);
}

async function failure(host: Host, workspace: string, input: unknown) {
  const output = await host.cli(
    ["--json", "--workspace", workspace, "--input", JSON.stringify(input), "agent"],
    false,
  );
  return errorResponse.parse(JSON.parse(z.string().parse(output)));
}
