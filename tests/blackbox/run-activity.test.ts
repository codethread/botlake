import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Runtime, ManualClock, sql, type Processes } from "@botlake/core";
import { agents, runActivityRelations } from "@botlake/extension-agents";
import { configureFlags } from "@botlake/extension-flags";
import { identity } from "@botlake/extension-identity";
import { sessionIdentity } from "@botlake/native-session";
import { z } from "zod";

import { system } from "./fixtures/system.ts";

const detail = z.object({
  sequence: z.number(),
  kind: z.string(),
  callId: z.string().nullable(),
  role: z.string().nullable(),
  summary: z.string(),
  truncated: z.boolean(),
  turnId: z.string().nullable(),
  outcome: z.string().nullable(),
});
const header = z.object({
  id: z.string(),
  run: z.string(),
  sessionId: z.string().nullable(),
  sessionPath: z.string().nullable(),
  endedAt: z.number().nullable(),
  expiredAt: z.number().nullable(),
  eventCount: z.number(),
});
const page = z.object({
  stream: header,
  events: z.array(detail),
  nextCursor: z.number().nullable(),
});
const peek = z.object({
  stream: header,
  outstandingTools: z.array(detail),
  recent: z.array(detail),
  latestUsage: z.unknown(),
});
const binding = z.object({ identity: z.string(), runId: z.string(), nodeId: z.string() });
const count = z.object({ count: z.number() });
const processes: Processes = {
  listOwned: async () => [],
  launch: unavailable,
  get: unavailable,
  cancel: unavailable,
  acknowledge: unavailable,
};

async function unavailable(): Promise<never> {
  throw new Error("No processes in this native session fixture");
}

test("run activity pages and searches SQL events, preserves live streams, and expires to one linked tombstone across restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "botlake-activity-"));
  const clock = new ManualClock(1000);
  const database = join(dir, "lake.sqlite");
  let runtime = new Runtime({ database, clock, processes });
  const extensions = () => [
    identity(),
    configureFlags([]),
    agents({ activity: { retentionMs: 100 } }),
  ];
  try {
    await runtime.start(extensions());
    const session = {
      provider: "codex",
      nativeSessionId: "session",
      cwd: dir,
      sessionPath: "/native/session.jsonl",
    };
    const native = async (event: string, activity: unknown[] = []) =>
      runtime.invoke("agent", {
        command: "native",
        ...session,
        event,
        activity,
        capabilities: ["activity", "tools", "messages"],
      });
    const registered = binding.parse(await native("session-start"));
    await native("agent-start", [
      { kind: "message", role: "user", summary: "Investigate VPN access" },
    ]);
    await native("metadata", [
      { kind: "tool-started", callId: "a", tool: "shell", summary: "bun test" },
    ]);
    await native("metadata", [
      { kind: "tool-started", callId: "b", tool: "read", summary: "README.md" },
    ]);
    await native("metadata", [
      { kind: "tool-ended", callId: "b", tool: "read", summary: "", outcome: "completed" },
    ]);
    const inspecting = peek.parse(
      await runtime.invoke("agent", {
        command: "activity",
        operation: "peek",
        id: registered.identity,
      }),
    );
    expect(inspecting.outstandingTools.map((event) => event.callId)).toEqual(["a"]);
    expect(inspecting.stream.sessionId).toBe("session");
    expect(inspecting.stream.sessionPath).toBe("/native/session.jsonl");
    const first = page.parse(
      await runtime.invoke("agent", {
        command: "activity",
        operation: "list",
        id: registered.runId,
        limit: 2,
      }),
    );
    expect(first.events).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const next = page.parse(
      await runtime.invoke("agent", {
        command: "activity",
        operation: "list",
        id: first.stream.id,
        after: first.nextCursor,
        limit: 2,
      }),
    );
    expect(next.events[0]?.sequence).toBeGreaterThan(first.events[1]?.sequence ?? 0);
    const search = page.parse(
      await runtime.invoke("agent", {
        command: "activity",
        operation: "search",
        id: first.stream.id,
        query: "VPN access",
      }),
    );
    expect(search.events.map((event) => event.summary)).toEqual(["Investigate VPN access"]);
    clock.advance(5000);
    await runtime.drain();
    expect(
      page.parse(
        await runtime.invoke("agent", {
          command: "activity",
          operation: "list",
          id: first.stream.id,
        }),
      ).events.length,
    ).toBeGreaterThan(0);
    await native("agent-end", [
      { kind: "message", role: "assistant", summary: "VPN needs enabling" },
    ]);
    await native("session-end");
    const ended = page.parse(
      await runtime.invoke("agent", {
        command: "activity",
        operation: "list",
        id: first.stream.id,
      }),
    );
    expect(ended.stream.endedAt).toBe(5000);
    await runtime.stop();
    clock.advance(5101);
    runtime = new Runtime({ database, clock, processes });
    await runtime.start(extensions());
    await runtime.drain();
    const expired = page.parse(
      await runtime.invoke("agent", {
        command: "activity",
        operation: "search",
        id: first.stream.id,
        query: "VPN",
      }),
    );
    expect(expired.events).toEqual([]);
    expect(expired.stream.id).toBe(first.stream.id);
    expect(expired.stream.eventCount).toBe(ended.stream.eventCount);
    expect(expired.stream.expiredAt).toBe(5101);
    expect(
      runtime.graph.edge(first.stream.id, registered.runId, runActivityRelations.run),
    ).not.toBeNull();
    expect(
      runtime.graph.edge(first.stream.id, registered.nodeId, runActivityRelations.identity),
    ).not.toBeNull();
    expect(
      count.parse(
        runtime.graph.db.query(sql`SELECT count(*) AS count FROM run_activity_events`).get(),
      ).count,
    ).toBe(0);
    expect(
      count.parse(runtime.graph.db.query(sql`SELECT count(*) AS count FROM run_activity`).get())
        .count,
    ).toBe(1);
    expect(
      count.parse(
        runtime.graph.db
          .query(
            sql`SELECT count(*) AS count FROM run_activity_search WHERE run_activity_search MATCH 'VPN'`,
          )
          .get(),
      ).count,
    ).toBe(0);
    await native("metadata", [{ kind: "message", role: "assistant", summary: "Late delivery" }]);
    expect(
      page.parse(
        await runtime.invoke("agent", {
          command: "activity",
          operation: "list",
          id: first.stream.id,
        }),
      ).events,
    ).toEqual([]);
    await native("session-start");
    const fresh = page.parse(
      await runtime.invoke("agent", {
        command: "activity",
        operation: "list",
        id: registered.runId,
      }),
    );
    expect(fresh.stream.id).not.toBe(first.stream.id);
    expect(fresh.stream.expiredAt).toBeNull();
    expect(runtime.errors).toEqual([]);
  } finally {
    await runtime.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("packed native plugins report tools, visible message excerpts and harness-reported usage through the public CLI", async () => {
  const host = await system();
  try {
    const workspace = await host.workspace("activity", [
      "@botlake/extension-identity",
      "@botlake/extension-flags",
      "@botlake/extension-agents",
    ]);
    await host.botlake(["lake", "start", "--workspace", workspace]);
    const plugin = join(workspace, "node_modules/@botlake/identity");
    const env = {
      ...host.env,
      BL_WORKSPACE: workspace,
      BL_RUN_REFERENCE: undefined,
      BL_NATIVE_SESSION_ID: undefined,
      BL_NATIVE_PROVIDER: undefined,
    };
    async function run(argv: string[], input?: unknown) {
      const child = Bun.spawn(argv, {
        cwd: workspace,
        env,
        stdin: input === undefined ? "ignore" : new Blob([JSON.stringify(input)]),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exit, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(stderr).toBe("");
      expect(exit).toBe(0);
      return stdout;
    }
    for (const provider of ["codex", "claude"] as const) {
      const nativeSessionId = `${provider}-activity`;
      const send = (name: string, extra: Record<string, unknown> = {}) =>
        run(["bun", join(plugin, "hook.ts"), provider], {
          hook_event_name: name,
          session_id: nativeSessionId,
          cwd: workspace,
          transcript_path: `/native/${provider}.jsonl`,
          ...(provider === "codex" ? { turn_id: "turn" } : { prompt_id: "turn" }),
          ...extra,
        });
      await send("SessionStart");
      await send("UserPromptSubmit", { prompt: `Investigate VPN access ${"x".repeat(3000)}` });
      await send("PreToolUse", {
        tool_use_id: "a",
        tool_name: "Bash",
        tool_input: { command: "bun test" },
      });
      await send("PreToolUse", {
        tool_use_id: "b",
        tool_name: "Read",
        tool_input: { file_path: "README.md" },
      });
      await send("PostToolUse", {
        tool_use_id: "b",
        tool_name: "Read",
        tool_input: { file_path: "README.md" },
      });
      const id = sessionIdentity({ provider, nativeSessionId });
      const live = peek.parse(
        await host.bl("activity", "agent", { command: "activity", operation: "peek", id }),
      );
      expect(live.outstandingTools.map((event) => event.callId)).toEqual(["a"]);
      await send(provider === "claude" ? "PostToolUseFailure" : "PostToolUse", {
        tool_use_id: "a",
        tool_name: "Bash",
        tool_input: { command: "bun test" },
      });
      if (provider === "claude") {
        await send("PreToolUse", {
          tool_use_id: "interrupted",
          tool_name: "Bash",
          tool_input: { command: "sleep 1" },
        });
        await send("PostToolUseFailure", {
          tool_use_id: "interrupted",
          tool_name: "Bash",
          is_interrupt: true,
        });
      }
      await send("Stop", { last_assistant_message: "VPN investigation complete" });
      await send("SessionEnd");
      const recorded = page.parse(
        await host.cli(["--workspace", "activity", "agent", "activity", "list", id]),
      );
      expect(recorded.stream.sessionPath).toBe(`/native/${provider}.jsonl`);
      expect(
        recorded.events.filter((event) => event.kind === "message").map((event) => event.role),
      ).toEqual(["user", "assistant"]);
      expect(recorded.events.find((event) => event.role === "user")?.truncated).toBe(true);
      expect(recorded.events.find((event) => event.role === "user")?.summary).toHaveLength(2048);
      expect(
        recorded.events.find((event) => event.kind === "tool-ended" && event.callId === "a")
          ?.outcome,
      ).toBe(provider === "claude" ? "failed" : "completed");
      if (provider === "claude")
        expect(
          recorded.events.find(
            (event) => event.kind === "tool-ended" && event.callId === "interrupted",
          )?.outcome,
        ).toBe("cancelled");
      expect(
        recorded.events
          .filter((event) => event.kind === "message" || event.kind.startsWith("tool-"))
          .every((event) => event.turnId === "turn"),
      ).toBe(true);
      expect(recorded.events.findIndex((event) => event.role === "assistant")).toBeLessThan(
        recorded.events.findIndex((event) => event.kind === "turn-ended"),
      );
      expect(recorded.events.findIndex((event) => event.kind === "turn-started")).toBeLessThan(
        recorded.events.findIndex((event) => event.role === "user"),
      );
      const cli = page.parse(
        await host.cli([
          "--workspace",
          "activity",
          "agent",
          "activity",
          "search",
          "investigation complete",
          "--target",
          id,
        ]),
      );
      expect(cli.events.map((event) => event.summary)).toEqual(["VPN investigation complete"]);
    }
    const piHost = join(workspace, "pi-host.ts");
    await Bun.write(
      piHost,
      `import identity from "@botlake/identity/pi";
const handlers=new Map(); identity({on(name,fn){handlers.set(name,fn)}});
const ctx={cwd:process.cwd(),sessionManager:{getSessionId:()=>"pi-activity",getSessionFile:()=>"/native/pi.jsonl"}};
const emit=async(name,event={})=>await handlers.get(name)(event,ctx);
await emit("session_start");await emit("agent_start");
await emit("message_end",{message:{role:"user",content:"Investigate VPN access"}});
await emit("tool_execution_start",{toolCallId:"pi-call",toolName:"bash",args:{command:"bun test"}});
await emit("tool_execution_end",{toolCallId:"pi-call",toolName:"bash",isError:false});
await emit("message_end",{message:{role:"assistant",content:[],usage:{input:0,output:0,totalTokens:0}}});
await emit("message_end",{message:{role:"assistant",content:[{type:"thinking",thinking:"private reasoning"},{type:"text",text:"VPN findings"}],usage:{input:10,output:5,cacheRead:2,cacheWrite:0,totalTokens:17,cost:{total:0.001}}}});
await emit("agent_end");await emit("session_shutdown");`,
    );
    await run(["bun", piHost]);
    const id = sessionIdentity({ provider: "pi", nativeSessionId: "pi-activity" });
    const pi = peek.parse(
      await host.cli(["--workspace", "activity", "agent", "activity", "peek", id]),
    );
    expect(pi.outstandingTools).toEqual([]);
    expect(
      pi.recent.filter((event) => event.kind === "message").map((event) => event.summary),
    ).toEqual(["Investigate VPN access", "VPN findings"]);
    expect(pi.latestUsage).toEqual({
      scope: "message",
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 2,
      cacheWriteTokens: 0,
      totalTokens: 17,
      cost: { amount: 0.001, currency: "USD" },
    });
    expect(pi.stream.sessionPath).toBe("/native/pi.jsonl");
    expect(JSON.stringify(pi)).not.toContain("private reasoning");
    const usageRows = z
      .object({ events: z.array(z.object({ kind: z.string(), usage: z.unknown() })) })
      .parse(
        await host.bl("activity", "agent", {
          command: "activity",
          operation: "list",
          id,
          limit: 100,
        }),
      );
    expect(usageRows.events.find((event) => event.kind === "usage")?.usage).toEqual({
      scope: "message",
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      cost: null,
    });
    expect(
      await host.cli(["--workspace", "activity", "agent", "activity", "peek"], false),
    ).toContain("Required positional: target");
    expect(
      await host.cli(
        ["--workspace", "activity", "agent", "activity", "peek", id, "--after", "1"],
        false,
      ),
    ).toContain("Unknown flag: --after");
    const global = z
      .object({ stream: z.null(), events: z.array(detail) })
      .parse(
        await host.cli(["--workspace", "activity", "agent", "activity", "search", "VPN findings"]),
      );
    expect(global.events.map((event) => event.summary)).toEqual(["VPN findings"]);
  } finally {
    await host.close();
  }
}, 60000);
