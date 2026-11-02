import { expect, test } from "bun:test";
import { join } from "node:path";

import { z } from "zod";

import { system } from "./fixtures/system.ts";

const sessionContext = z.object({
  provider: z.string(),
  audience: z.string(),
  model: z.string().nullable(),
  effort: z.string().nullable(),
  seat: z.string().nullable(),
  cwd: z.string(),
  workspace: z.string(),
});
const identifier = z.string();

test("session context resolves identity metadata and latest observed audience without Agents activation", async () => {
  const host = await system();
  try {
    const workspace = await host.workspace("session-context", ["./context.ts"]);
    await Bun.write(
      join(workspace, "context.ts"),
      `import {defineOp,jsonSchema,type Extension} from "@botlake/core";
import {resolveSessionContext} from "@botlake/extension-agents";
import {identityAttributes} from "@botlake/extension-identity";
import {agentAttributes} from "@botlake/extension-agents";
import {z} from "zod";
const input=z.compile(z.discriminatedUnion("command",[
 z.object({command:z.literal("identity"),model:z.string().nullable().optional(),seat:z.string().nullable().optional(),effort:z.string().nullable().optional()}),
 z.object({command:z.literal("observe"),label:z.string(),at:z.number(),audience:z.enum(["human","agent","unknown"]),archive:z.boolean().default(false)}),
 z.object({command:z.literal("resolve")})]));
const extension:Extension={name:"context",activate(ctx){let identity:string|undefined;ctx.register(defineOp({name:"context",input,output:jsonSchema,handler(value,_ctx,invocation){
 if(value.command==="identity"){if(identity===undefined)identity=ctx.graph.add({title:"fixture",attributes:{[identityAttributes.session]:true,[identityAttributes.id]:"fixture",[identityAttributes.provider]:"pi"}}).id;const patch:Record<string,unknown>={};if(value.model!==undefined)patch[identityAttributes.model]=value.model;if(value.seat!==undefined)patch[identityAttributes.agentSeat]=value.seat;if(value.effort!==undefined)patch[identityAttributes.thinkingLevel]=value.effort;ctx.graph.setAttributes(identity,patch);return null;}
 if(value.command==="observe"){const run=ctx.graph.add({title:value.label,attributes:{[agentAttributes.run]:true,[agentAttributes.identity]:"fixture",[agentAttributes.observation]:{at:value.at,audience:value.audience}}});if(value.archive)ctx.graph.archive(run.id,[agentAttributes.observation]);return run.id;}
 return resolveSessionContext(ctx,invocation);}}));}};export default extension;`,
    );
    await host.botlake(["lake", "start", "--workspace", workspace]);

    expect(await host.bl(workspace, "context", { command: "resolve" })).toBeNull();
    await host.bl(workspace, "context", {
      command: "identity",
      model: "deepseek/v3",
      seat: "reviewer",
      effort: "high",
    });
    const initial = sessionContext.parse(
      await host.bl(workspace, "context", { command: "resolve" }),
    );
    expect(initial).toMatchObject({
      provider: "pi",
      audience: "unknown",
      model: "deepseek/v3",
      seat: "reviewer",
      effort: "high",
    });
    expect(initial.workspace).toBe(`${initial.cwd}/session-context`);

    await host.bl(workspace, "context", { command: "identity", model: null, effort: "low" });
    await host.bl(workspace, "context", {
      command: "observe",
      label: "archived",
      at: 10,
      audience: "agent",
      archive: true,
    });
    expect(await host.bl(workspace, "context", { command: "resolve" })).toMatchObject({
      audience: "agent",
    });
    const humanRun = identifier.parse(
      await host.bl(workspace, "context", {
        command: "observe",
        label: "human",
        at: 20,
        audience: "human",
      }),
    );
    const agentRun = identifier.parse(
      await host.bl(workspace, "context", {
        command: "observe",
        label: "agent",
        at: 20,
        audience: "agent",
      }),
    );
    expect(await host.bl(workspace, "context", { command: "resolve" })).toMatchObject({
      audience: agentRun > humanRun ? "agent" : "human",
      model: null,
      seat: "reviewer",
      effort: "low",
    });
  } finally {
    await host.close();
  }
}, 30_000);
