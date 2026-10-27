import { test, expect } from "bun:test";
import { chmod } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { system } from "./fixtures/system.ts";

const runSchema = z.object({ id: z.string(), attributes: z.record(z.string(), z.json()) });

test("native providers preserve complete evidence on interrupted output and require observed headless sessions", async () => {
  const host = await system();
  try {
    const workspace = await host.workspace("providers", [
      "@botlake/extension-identity",
      "@botlake/extension-flags",
      "./providers.ts",
    ]);
    const executable = join(workspace, "native-cli");
    await Bun.write(
      executable,
      `#!/usr/bin/env bun
import {spawnSync} from "node:child_process";
const args=Bun.argv.slice(2), name=process.env.FIXTURE_PROVIDER;
const scenario=(await Bun.stdin.text()).trim();
const option=key=>args[args.indexOf(key)+1];
if(option("--model")!=="fixture" || !args.includes(name==="codex"?"--json": "--print")) throw new Error("Wrong prepared command: "+JSON.stringify(args));
if(name==="codex" && (!args.includes('model_reasoning_effort="medium"') || !args.includes('developer_instructions="policy"'))) throw new Error("Missing Codex settings");
if(name!=="codex" && (option(name==="pi"?"--thinking":"--effort")!=="medium" || option("--append-system-prompt")!=="policy")) throw new Error("Missing native settings");
const resumed=name==="codex"?args.includes("resume"):args.includes(name==="pi"?"--session":"--resume");
if(args.includes("--session-id"))throw new Error("Fresh sessions must be native-owned");
const session=resumed?(name==="codex"?args.at(-2):option(name==="pi"?"--session":"--resume")):"native-"+crypto.randomUUID();
const [runId,invocation]=process.env.BL_RUN_REFERENCE.split(":");
const binding=spawnSync(process.env.BL_BIN,["--workspace",process.env.BL_WORKSPACE,"--input",JSON.stringify({command:"native",provider:name,cwd:process.cwd(),nativeSessionId:session,runId,invocation}),"agent"],{encoding:"utf8"});
if(binding.status!==0)throw new Error(binding.stderr);
const emit=event=>console.log(JSON.stringify(event));
if(name==="claude") {
  if(scenario==="truncated")process.stdout.write('{"session_id":');
  else emit({session_id:scenario==="no-session"?undefined:session,result:"answer",is_error:scenario==="failed"});
} else {
  if(scenario!=="no-session")emit(name==="codex"?{type:"thread.started",thread_id:session}:{type:"session",id:session});
  if(name==="codex") {
    emit({type:"item.completed",item:{type:"agent_message",text:"answer"}});
    if(scenario==="failed")emit({type:"turn.failed",error:{message:"provider failure"}});
  } else {
    emit({type:"message_end",message:{role:"user",content:"ignored user text"}});
    emit({type:"message_end",message:{role:"assistant",content:[{type:"thinking",text:"private"},{type:"text",text:"first"},{type:"text",text:" "},{type:"text",text:"second"}],stopReason:"stop"}});
    if(scenario==="failed")emit({type:"message_update",message:{role:"assistant",content:[],stopReason:"error",errorMessage:"provider failure"}});
  }
  if(scenario==="truncated")process.stdout.write('{"type":');
}
`,
    );
    await chmod(executable, 0o755);
    await Bun.write(
      join(workspace, "providers.ts"),
      `import {agents,provider} from "@botlake/extension-agents";
const names=["codex","pi","claude"];
export default agents({providers:names.map(name=>{const base=provider(name);return {...base,prepare(run){const plan=base.prepare(run);return {...plan,command:[${JSON.stringify(executable)},...plan.command.slice(1)],env:{...plan.env,FIXTURE_PROVIDER:name}};}};}),aliases:Object.fromEntries(names.map(name=>[name+"-seat",{provider:name,model:"fixture",effort:"medium",systemPrompt:"policy"}]))});`,
    );
    await host.botlake(["lake", "start", "--workspace", workspace]);
    async function settled(id: string): Promise<z.infer<typeof runSchema>> {
      for (let attempt = 0; attempt < 100; attempt++) {
        await host.bl("providers", "agent", { command: "reconcile" });
        const run = runSchema.parse(await host.bl("providers", "agent", { command: "show", id }));
        if (run.attributes["agent/settled"] === true) return run;
      }
      throw new Error(`Provider did not settle: ${id}`);
    }
    for (const name of ["codex", "pi", "claude"]) {
      for (const scenario of ["complete", "failed", "truncated", "no-session"]) {
        const started = runSchema.parse(
          await host.bl("providers", "agent", {
            command: "start",
            seat: `${name}-seat`,
            cwd: workspace,
            prompt: scenario,
          }),
        );
        const run = await settled(started.id);
        expect(run.attributes["agent/state"]).toBe(scenario === "complete" ? "stopped" : "failed");
        expect(run.attributes["agent/substatus"]).toBe(
          scenario === "complete" ? "completed" : "execution",
        );
        if (name === "claude" && scenario === "truncated") {
          expect(run.attributes["agent/result"]).toBeUndefined();
        } else {
          expect(run.attributes["agent/result"]).toBe(name === "pi" ? "first\n\nsecond" : "answer");
        }
        if (scenario === "truncated" && name !== "claude") {
          expect(run.attributes["agent/session-confirmed"]).toBe(true);
          expect(run.attributes["agent/error"]).toContain("JSONL");
        }
        if (scenario === "no-session")
          expect(run.attributes["agent/error"]).toContain(
            name === "codex" ? "no thread id" : "no session id",
          );
        if (scenario === "complete") {
          const resumed = runSchema.parse(
            await host.bl("providers", "agent", {
              command: "resume",
              id: run.id,
              prompt: "complete",
            }),
          );
          const continuation = await settled(resumed.id);
          expect(continuation.attributes["agent/state"]).toBe("stopped");
          expect(continuation.attributes["agent/session-id"]).toBe(
            run.attributes["agent/session-id"],
          );
        }
      }
    }
  } finally {
    await host.close();
  }
}, 60000);
