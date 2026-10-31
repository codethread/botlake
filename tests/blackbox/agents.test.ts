import { test, expect } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { agentAttributes } from "@botlake/extension-agents";
import { z } from "zod";

import { system } from "./fixtures/system.ts";

const status = z.compile(
  z.strictObject({
    id: z.string(),
    state: z.string(),
    substatus: z.string(),
    settled: z.boolean(),
  }),
);
const row = z.compile(
  z.object({
    id: z.string(),
    state: z.string(),
    attributes: z.record(z.string(), z.json()),
  }),
);
const performed = z.compile(z.array(z.object({ relation: z.string() })));
const nativeRun = z.compile(z.object({ runId: z.string() }));
const workItem = z.compile(
  z.object({ id: z.string(), kind: z.enum(["task", "group"]), state: z.string() }),
);
test("Agents publishes, binds actual native sessions, fences writes, reconciles custody and resumes without Workflow", async () => {
  const host = await system();
  try {
    const workspace = await host.workspace("agents", [
      "@botlake/extension-batteries",
      "@botlake/extension-identity",
      "./flags.ts",
      "./providers.ts",
      "@botlake/extension-work",
    ]);
    await Bun.write(
      join(workspace, "flags.ts"),
      `import { agentFlags } from "@botlake/extension-agents";
import { configureFlags } from "@botlake/extension-flags";
export default configureFlags([[agentFlags.codex, true]]);`,
    );
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
      `import {agents,provider} from "@botlake/extension-agents";const base=provider("codex");export default agents({providers:[{...base,prepare(run){if(run.prompt==="preparation-failure")throw new Error("fixture preparation failure");return {command:["bun",${JSON.stringify(childPath)}],stdin:"",env:{...(run.resumes?{BL_SESSION_ID:run.sessionId}:{}),TEST_PROMPT:run.prompt}};}}],aliases:{worker:{provider:"codex"}}});`,
    );
    await host.botlake(["lake", "start", "--workspace", workspace]);
    const target = workItem.parse(
      await host.bl("agents", "work", { command: "create", kind: "task", title: "Work" }),
    );
    const first = status.parse(
      await host.bl("agents", "agent", {
        command: "start",
        seat: "worker",
        cwd: workspace,
        prompt: "Do work",
        requestId: "one",
        target: target.id,
      }),
    );
    expect(first.state).toBe("running");
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
    const replay = status.parse(
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
    let settled = row.parse(await host.bl("agents", "agent", { command: "show", id: first.id }));
    for (
      let attempts = 0;
      attempts < 100 && settled.attributes[agentAttributes.settled] !== true;
      attempts++
    ) {
      await host.bl("agents", "agent", { command: "reconcile" });
      settled = row.parse(await host.bl("agents", "agent", { command: "show", id: first.id }));
    }
    expect(settled.attributes[agentAttributes.substatus]).toBe("completed");
    expect(row.parse(await host.bl("agents", "show", { id: target.id })).state).toBe("active");
    const resumed = status.parse(
      await host.bl("agents", "agent", {
        command: "resume",
        id: first.id,
        prompt: "Continue",
        requestId: "two",
      }),
    );
    const resumedRun = row.parse(
      await host.bl("agents", "agent", { command: "show", id: resumed.id }),
    );
    expect(resumedRun.attributes[agentAttributes.identity]).toBe(
      settled.attributes[agentAttributes.identity],
    );
    expect(resumedRun.attributes[agentAttributes.sessionId]).toBe(
      settled.attributes[agentAttributes.sessionId],
    );
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
    const retryStart = status.parse(
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
        attempts < 100 && run.attributes[agentAttributes.settled] !== true;
        attempts++
      ) {
        await host.bl("agents", "agent", { command: "reconcile" });
        run = row.parse(await host.bl("agents", "agent", { command: "show", id }));
      }
      return run;
    }
    let retry = await settle(retryStart.id);
    expect(retry.attributes[agentAttributes.substatus]).toBe("execution");
    const previousActivity = z.string().parse(retry.attributes[agentAttributes.activity]);
    expect(await host.bl("agents", "agent", { command: "acknowledge", id: retry.id })).toEqual({
      id: retry.id,
      acknowledged: true,
    });
    await host.bl("agents", "agent", { command: "retry", id: retry.id });
    retry = await settle(retry.id);
    expect(retry.attributes[agentAttributes.acknowledged]).toBe(false);
    expect(retry.attributes[agentAttributes.activity]).not.toBe(previousActivity);
    const earlier = z.object({ stream: z.object({ id: z.string(), endedAt: z.number() }) }).parse(
      await host.bl("agents", "agent", {
        command: "activity",
        operation: "list",
        id: previousActivity,
      }),
    );
    expect(earlier.stream.id).toBe(previousActivity);
    expect(retry.attributes[agentAttributes.substatus]).toBe("completed");
    expect(retry.attributes[agentAttributes.integration]).toBe("output");
    expect(retry.attributes[agentAttributes.sessionConfirmed]).toBe(true);
    const parentA = await settle(
      status.parse(
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
      status.parse(
        await host.bl("agents", "agent", {
          command: "start",
          seat: "worker",
          cwd: other,
          prompt: "parent",
          requestId: "parent-b",
        }),
      ).id,
    );
    const childA = status.parse(
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
        agentAttributes.identity
      ],
    ).toBe(parentA.attributes[agentAttributes.identity]);
    const cancellable = status.parse(
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
        performed.parse(
          await host.bl("agents", "edge", {
            command: "list",
            id: cancellable.id,
            relation: "performed",
          }),
        ).length > 0;
    expect(bound).toBe(true);
    const beforeRestart = row.parse(
      await host.bl("agents", "agent", { command: "show", id: cancellable.id }),
    );
    await host.botlake(["restart-host"]);
    expect(
      row.parse(await host.bl("agents", "agent", { command: "show", id: cancellable.id }))
        .attributes[agentAttributes.handle],
    ).toBe(beforeRestart.attributes[agentAttributes.handle]);
    const cancelled = status.parse(
      await host.bl("agents", "agent", { command: "cancel", id: cancellable.id }),
    );
    expect(cancelled.substatus).toBe("requested");
    expect(cancelled.settled).toBe(true);
    const external = nativeRun.parse(
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

    // A queued run restores without launching, and can be abandoned without process custody.
    const prerequisite = workItem.parse(
      await host.bl("agents", "work", { command: "create", kind: "task", title: "Prerequisite" }),
    );
    const waiting = workItem.parse(
      await host.bl("agents", "work", {
        command: "create",
        kind: "task",
        title: "Waiting work",
        prerequisites: [prerequisite.id],
      }),
    );
    const queued = status.parse(
      await host.bl("agents", "agent", {
        command: "start",
        seat: "worker",
        cwd: workspace,
        prompt: "Wait for prerequisite",
        target: waiting.id,
      }),
    );
    expect(queued.state).toBe("ready");
    await host.botlake(["restart-host"]);
    expect(
      row.parse(await host.bl("agents", "agent", { command: "show", id: queued.id })).attributes[
        agentAttributes.handle
      ],
    ).toBeUndefined();
    expect(
      status.parse(await host.bl("agents", "agent", { command: "cancel", id: queued.id })),
    ).toEqual({ id: queued.id, state: "stopped", substatus: "abandoned", settled: true });
    expect(await host.bl("agents", "agent", { command: "acknowledge", id: queued.id })).toEqual({
      id: queued.id,
      acknowledged: true,
    });
    const preparationFailure = status.parse(
      await host.bl("agents", "agent", {
        command: "start",
        seat: "worker",
        cwd: workspace,
        prompt: "preparation-failure",
      }),
    );
    expect(preparationFailure).toEqual({
      id: preparationFailure.id,
      state: "failed",
      substatus: "reconciliation",
      settled: true,
    });
    expect(
      await host.bl("agents", "agent", { command: "acknowledge", id: preparationFailure.id }),
    ).toEqual({ id: preparationFailure.id, acknowledged: true });
    expect(row.parse(await host.bl("agents", "show", { id: waiting.id })).state).toBe("active");
  } finally {
    await host.close();
  }
}, 60000);
