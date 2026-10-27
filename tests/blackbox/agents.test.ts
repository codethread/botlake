import { test, expect } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { system } from "./fixtures/system.ts";

const row = z.object({
  id: z.string(),
  state: z.string(),
  attributes: z.record(z.string(), z.json()),
});
test("Agents publishes, binds actual native sessions, fences writes, reconciles custody and resumes without Workflow", async () => {
  const host = await system();
  try {
    const workspace = await host.workspace("agents", [
      "@botlake/extension-batteries",
      "@botlake/extension-identity",
      "@botlake/extension-flags",
      "./providers.ts",
      "@botlake/extension-kanban",
    ]);
    const childPath = join(workspace, "child.ts");
    await Bun.write(
      childPath,
      `import {spawnSync} from "node:child_process"; import {existsSync,writeFileSync} from "node:fs";
const session=process.env.BL_SESSION_ID??crypto.randomUUID(); const prompt=process.env.TEST_PROMPT; const marker=${JSON.stringify(join(workspace, "attempted"))}; const skip=prompt==="retry"&&existsSync(marker);
if(!skip){const reply=spawnSync("bun",[${JSON.stringify(join(workspace, "node_modules/@botlake/identity/hook.ts"))},"codex"],{encoding:"utf8",input:JSON.stringify({hook_event_name:"SessionStart",session_id:session,cwd:process.cwd(),source:"startup"})});if(reply.status!==0||!JSON.parse(reply.stdout).hookSpecificOutput)throw new Error(reply.stderr+reply.stdout);}
if(prompt==="cancel"){setInterval(()=>{},1000);}else{console.log(JSON.stringify({type:"thread.started",thread_id:session}));console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"done"}}));if(prompt==="retry"&&!skip){writeFileSync(marker,"attempted");console.log(JSON.stringify({type:"turn.failed",error:{message:"first failure"}}));process.exitCode=1;}else console.log(JSON.stringify({type:"turn.completed"}));}`,
    );
    await Bun.write(
      join(workspace, "providers.ts"),
      `import {agents,provider} from "@botlake/extension-agents";const base=provider("codex");export default agents({providers:[{...base,prepare(run){return {command:["bun",${JSON.stringify(childPath)}],stdin:"",env:{...(run.resumes?{BL_SESSION_ID:run.sessionId}:{}),TEST_PROMPT:run.prompt}};}}],aliases:{worker:{provider:"codex"}}});`,
    );
    await host.botlake(["lake", "start", "--workspace", workspace]);
    const target = row.parse(await host.bl("agents", "kanban", { command: "add", title: "Work" }));
    const first = row.parse(
      await host.bl("agents", "agent", {
        command: "start",
        seat: "worker",
        cwd: workspace,
        prompt: "Do work",
        requestId: "one",
        target: target.id,
      }),
    );
    expect(first.attributes["agent/state"]).toBe("running");
    expect(
      await host.bl(
        "agents",
        "agent",
        {
          command: "native",
          provider: "codex",
          cwd: workspace,
          nativeSessionId: "forged",
          runId: first.id,
          invocation: "stale",
        },
        false,
      ),
    ).toContain("Stale");
    const replay = row.parse(
      await host.bl("agents", "agent", {
        command: "start",
        seat: "worker",
        cwd: workspace,
        prompt: "Do work",
        requestId: "one",
        target: target.id,
      }),
    );
    expect(replay.id).toBe(first.id);
    expect(
      await host.bl(
        "agents",
        "agent",
        {
          command: "start",
          seat: "worker",
          cwd: workspace,
          prompt: "Changed",
          requestId: "one",
          target: target.id,
        },
        false,
      ),
    ).toContain("different input");
    expect(await host.bl("agents", "update", { id: first.id, state: "closed" }, false)).toContain(
      "Agents API",
    );
    // Public reconciliation is the synchronization boundary; it observes Botlake's terminal fact.
    let settled = first;
    for (
      let attempts = 0;
      attempts < 100 && settled.attributes["agent/settled"] !== true;
      attempts++
    ) {
      await host.bl("agents", "agent", { command: "reconcile" });
      settled = row.parse(await host.bl("agents", "agent", { command: "show", id: first.id }));
    }
    expect(settled.attributes["agent/substatus"]).toBe("completed");
    expect(row.parse(await host.bl("agents", "show", { id: target.id })).state).toBe("active");
    const resumed = row.parse(
      await host.bl("agents", "agent", {
        command: "resume",
        id: first.id,
        prompt: "Continue",
        requestId: "two",
      }),
    );
    expect(resumed.attributes["agent/identity"]).toBe(settled.attributes["agent/identity"]);
    expect(resumed.attributes["agent/session-id"]).toBe(settled.attributes["agent/session-id"]);
    expect(
      await host.bl(
        "agents",
        "agent",
        {
          command: "native",
          provider: "codex",
          cwd: workspace,
          nativeSessionId: "forged",
          runId: resumed.id,
          invocation: "stale",
        },
        false,
      ),
    ).toContain("Stale");
    const other = join(host.dir, "other-cwd");
    await mkdir(other);
    let retry = row.parse(
      await host.bl("agents", "agent", {
        command: "start",
        seat: "worker",
        cwd: other,
        prompt: "retry",
      }),
    );
    async function settle(id: string): Promise<z.infer<typeof row>> {
      let run = row.parse(await host.bl("agents", "agent", { command: "show", id }));
      for (
        let attempts = 0;
        attempts < 100 && run.attributes["agent/settled"] !== true;
        attempts++
      ) {
        await host.bl("agents", "agent", { command: "reconcile" });
        run = row.parse(await host.bl("agents", "agent", { command: "show", id }));
      }
      return run;
    }
    retry = await settle(retry.id);
    expect(retry.attributes["agent/substatus"]).toBe("execution");
    await host.bl("agents", "agent", { command: "retry", id: retry.id });
    retry = await settle(retry.id);
    expect(retry.attributes["agent/substatus"]).toBe("completed");
    expect(retry.attributes["agent/integration"]).toBe("output");
    expect(retry.attributes["agent/session-confirmed"]).toBe(true);
    const parentA = await settle(
      row.parse(
        await host.bl("agents", "agent", {
          command: "start",
          seat: "worker",
          cwd: other,
          prompt: "parent",
          requestId: "parent-a",
        }),
      ).id,
    );
    const parentB = await settle(
      row.parse(
        await host.bl("agents", "agent", {
          command: "start",
          seat: "worker",
          cwd: other,
          prompt: "parent",
          requestId: "parent-b",
        }),
      ).id,
    );
    const childA = row.parse(
      await host.bl("agents", "agent", {
        command: "resume",
        id: parentA.id,
        prompt: "shared",
        requestId: "shared-resume",
      }),
    );
    expect(
      await host.bl(
        "agents",
        "agent",
        { command: "resume", id: parentB.id, prompt: "shared", requestId: "shared-resume" },
        false,
      ),
    ).toContain("different input");
    expect(
      row.parse(await host.bl("agents", "agent", { command: "show", id: childA.id })).attributes[
        "agent/identity"
      ],
    ).toBe(parentA.attributes["agent/identity"]);
    const cancellable = row.parse(
      await host.bl("agents", "agent", {
        command: "start",
        seat: "worker",
        cwd: other,
        prompt: "cancel",
      }),
    );
    let bound = false;
    for (let checks = 0; checks < 100 && !bound; checks++)
      bound =
        z.array(z.object({ relation: z.string() })).parse(
          await host.bl("agents", "edge", {
            command: "list",
            id: cancellable.id,
            relation: "performed",
          }),
        ).length > 0;
    expect(bound).toBe(true);
    await host.botlake(["restart-host"]);
    expect(
      row.parse(await host.bl("agents", "agent", { command: "show", id: cancellable.id }))
        .attributes["agent/handle"],
    ).toBe(cancellable.attributes["agent/handle"]);
    const cancelled = row.parse(
      await host.bl("agents", "agent", { command: "cancel", id: cancellable.id }),
    );
    expect(cancelled.attributes["agent/substatus"]).toBe("requested");
    expect(cancelled.attributes["agent/settled"]).toBe(true);
    const external = z.object({ runId: z.string() }).parse(
      await host.bl("agents", "agent", {
        command: "native",
        provider: "pi",
        cwd: workspace,
        nativeSessionId: "external",
      }),
    );
    expect(
      await host.bl("agents", "agent", { command: "cancel", id: external.runId }, false),
    ).toContain("no stop authority");
  } finally {
    await host.close();
  }
}, 60000);
