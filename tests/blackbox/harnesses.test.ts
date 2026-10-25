import { test, expect } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { system, source } from "./fixtures/system.ts";

const row = z.object({
  id: z.string(),
  state: z.string(),
  attributes: z.record(z.string(), z.json()),
});
test("Harnesses publishes, binds actual native sessions, fences writes, reconciles custody and resumes without Workflow", async () => {
  const host = await system();
  try {
    const workspace = await host.workspace("agents", [
      "batteries",
      "identity",
      "./providers.ts",
      "kanban",
    ]);
    const childPath = join(workspace, "child.ts");
    await Bun.write(
      childPath,
      `import {spawnSync} from "node:child_process"; import {existsSync,writeFileSync} from "node:fs";
const session=process.env.MILLSTRAND_SESSION_ID; const prompt=process.env.TEST_PROMPT; const marker=${JSON.stringify(join(workspace, "attempted"))}; const skip=prompt==="retry"&&existsSync(marker);
if(!skip){const reply=spawnSync("bun",[${JSON.stringify(join(source, "plugins/identity/hook.ts"))},"codex"],{encoding:"utf8",input:JSON.stringify({hook_event_name:"SessionStart",session_id:session,cwd:process.cwd(),source:"startup"})});if(reply.status!==0||!JSON.parse(reply.stdout).hookSpecificOutput)throw new Error(reply.stderr+reply.stdout);}
if(prompt==="cancel"){setInterval(()=>{},1000);}else{console.log(JSON.stringify({type:"thread.started",thread_id:session}));console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"done"}}));if(prompt==="retry"&&!skip){writeFileSync(marker,"attempted");console.log(JSON.stringify({type:"turn.failed",error:{message:"first failure"}}));process.exitCode=1;}else console.log(JSON.stringify({type:"turn.completed"}));}`,
    );
    await Bun.write(
      join(workspace, "providers.ts"),
      `import {harnesses,provider} from ${JSON.stringify(join(source, "src/index.ts"))};const base=provider("codex");export default harnesses({providers:[{...base,prepare(run){return {command:["bun",${JSON.stringify(childPath)}],stdin:"",env:{MILLSTRAND_SESSION_ID:run.sessionId,TEST_PROMPT:run.prompt}};}}],aliases:{worker:{provider:"codex"}},reviewers:{code:{seats:["missing","worker"],prompt:"Review changes",labels:["code"],paths:["*.ts"]}}});`,
    );
    await host.mill(["up", workspace]);
    const target = row.parse(
      await host.strand("agents", "kanban", { command: "add", title: "Work" }),
    );
    const first = row.parse(
      await host.strand("agents", "agent", {
        command: "start",
        seat: "worker",
        cwd: workspace,
        prompt: "Do work",
        requestId: "one",
        target: target.id,
      }),
    );
    expect(first.attributes["harness/state"]).toBe("running");
    expect(
      await host.strand(
        "agents",
        "identity",
        {
          command: "startup",
          harness: "codex",
          nativeSessionId: first.attributes["harness/session-id"],
          identity: first.attributes["harness/identity"],
          reservationId: first.attributes["harness/reservation-id"],
          runId: first.id,
        },
        false,
      ),
    ).toContain("Stale native invocation");
    const replay = row.parse(
      await host.strand("agents", "agent", {
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
      await host.strand(
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
    expect(
      await host.strand("agents", "update", { id: first.id, state: "closed" }, false),
    ).toContain("Harnesses API");
    // Public reconciliation is the synchronization boundary; it observes Mill's terminal fact.
    let settled = first;
    for (
      let attempts = 0;
      attempts < 100 && settled.attributes["harness/settled"] !== true;
      attempts++
    ) {
      await host.strand("agents", "agent", { command: "reconcile" });
      settled = row.parse(await host.strand("agents", "agent", { command: "show", id: first.id }));
    }
    expect(settled.attributes["harness/substatus"]).toBe("completed");
    expect(row.parse(await host.strand("agents", "show", { id: target.id })).state).toBe("active");
    const resumed = row.parse(
      await host.strand("agents", "agent", {
        command: "resume",
        id: first.id,
        prompt: "Continue",
        requestId: "two",
      }),
    );
    expect(resumed.attributes["harness/identity"]).toBe(settled.attributes["harness/identity"]);
    expect(resumed.attributes["harness/session-id"]).toBe(settled.attributes["harness/session-id"]);
    expect(
      await host.strand(
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
      await host.strand("agents", "agent", {
        command: "start",
        seat: "worker",
        cwd: other,
        prompt: "retry",
      }),
    );
    async function settle(id: string): Promise<z.infer<typeof row>> {
      let run = row.parse(await host.strand("agents", "agent", { command: "show", id }));
      for (
        let attempts = 0;
        attempts < 100 && run.attributes["harness/settled"] !== true;
        attempts++
      ) {
        await host.strand("agents", "agent", { command: "reconcile" });
        run = row.parse(await host.strand("agents", "agent", { command: "show", id }));
      }
      return run;
    }
    retry = await settle(retry.id);
    expect(retry.attributes["harness/substatus"]).toBe("execution");
    await host.strand("agents", "agent", { command: "retry", id: retry.id });
    retry = await settle(retry.id);
    expect(retry.attributes["harness/substatus"]).toBe("bootstrap");
    expect(retry.attributes["harness/session-confirmed"]).toBe(false);
    expect(
      await host.strand(
        "agents",
        "agent",
        { command: "resume", id: retry.id, prompt: "wrong" },
        false,
      ),
    ).toContain("verified native session");
    const parentA = await settle(
      row.parse(
        await host.strand("agents", "agent", {
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
        await host.strand("agents", "agent", {
          command: "start",
          seat: "worker",
          cwd: other,
          prompt: "parent",
          requestId: "parent-b",
        }),
      ).id,
    );
    const childA = row.parse(
      await host.strand("agents", "agent", {
        command: "resume",
        id: parentA.id,
        prompt: "shared",
        requestId: "shared-resume",
      }),
    );
    expect(
      await host.strand(
        "agents",
        "agent",
        { command: "resume", id: parentB.id, prompt: "shared", requestId: "shared-resume" },
        false,
      ),
    ).toContain("different input");
    expect(
      row.parse(await host.strand("agents", "agent", { command: "show", id: childA.id }))
        .attributes["harness/identity"],
    ).toBe(parentA.attributes["harness/identity"]);
    const cancellable = row.parse(
      await host.strand("agents", "agent", {
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
          await host.strand("agents", "edge", {
            command: "list",
            id: cancellable.id,
            relation: "performed",
          }),
        ).length > 0;
    expect(bound).toBe(true);
    await host.mill(["restart-host"]);
    expect(
      row.parse(await host.strand("agents", "agent", { command: "show", id: cancellable.id }))
        .attributes["harness/handle"],
    ).toBe(cancellable.attributes["harness/handle"]);
    const cancelled = row.parse(
      await host.strand("agents", "agent", { command: "cancel", id: cancellable.id }),
    );
    expect(cancelled.attributes["harness/substatus"]).toBe("requested");
    expect(cancelled.attributes["harness/settled"]).toBe(true);
    async function git(args: string[]): Promise<void> {
      const command = Bun.spawn(["git", "-C", workspace, ...args], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, error] = await Promise.all([
        command.exited,
        new Response(command.stderr).text(),
      ]);
      if (code !== 0) throw new Error(error);
    }
    await git(["init"]);
    await Bun.write(join(workspace, "app.ts"), "export const value = 1;\n");
    await git(["add", "app.ts"]);
    await git([
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "baseline",
    ]);
    expect(
      z
        .object({ reason: z.string() })
        .parse(await host.strand("agents", "agent", { command: "review", cwd: workspace })).reason,
    ).toBe("empty-diff");
    await Bun.write(join(workspace, "app.ts"), "export const value = 2;\n");
    expect(
      z.object({ runs: z.array(row) }).parse(
        await host.strand("agents", "agent", {
          command: "review",
          cwd: workspace,
          labels: ["code"],
        }),
      ).runs,
    ).toHaveLength(1);
    const external = z.object({ runId: z.string() }).parse(
      await host.strand("agents", "agent", {
        command: "native",
        provider: "pi",
        cwd: workspace,
        nativeSessionId: "external",
      }),
    );
    expect(
      await host.strand("agents", "agent", { command: "cancel", id: external.runId }, false),
    ).toContain("no stop authority");
  } finally {
    await host.close();
  }
}, 60000);
