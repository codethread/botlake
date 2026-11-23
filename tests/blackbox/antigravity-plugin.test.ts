import { expect, test } from "bun:test";
import { join } from "node:path";

import { sessionIdentity } from "@botlake/native-session";
import { z } from "zod";

import { source, system } from "./fixtures/system.ts";

const command = z.object({ type: z.literal("command"), command: z.string() });
const toolMatcher = z.object({ matcher: z.literal("*"), hooks: z.tuple([command]) });
const systemSteps = z.object({
  injectSteps: z.tuple([z.object({ systemMessage: z.object({ systemMessage: z.string() }) })]),
});
const notices = z.object({ injectSteps: z.tuple([z.object({ ephemeralMessage: z.string() })]) });

// Replay the documented stdin contract against the commands Antigravity would discover and run.
// No real agy binary, user configuration or model calls.
test("built Antigravity plugins bind the conversation, observe its loop and hand off mail", async () => {
  const host = await system();
  try {
    const bundles = join(host.dir, "built plugins");
    const build = Bun.spawn(["bun", join(source, "scripts/plugins.ts"), bundles], {
      stdout: "ignore",
    });
    expect(await build.exited).toBe(0);
    const lake = await host.workspace("agy-hooks", [
      "@botlake/extension-identity",
      "@botlake/extension-mail",
      "./agents.ts",
    ]);
    await Bun.write(
      join(lake, "agents.ts"),
      `import {agents} from "@botlake/extension-agents";\nexport default agents({unmanaged:{systemPrompt:"Use this lake"}});`,
    );
    expect(await Bun.spawn(["git", "init", "-q", lake]).exited).toBe(0);
    await host.botlake(["lake", "start", "--workspace", lake]);

    const common = {
      conversationId: "ec33ebf9-0cba-4100-8142-c61503f6c587",
      workspacePaths: [lake, host.dir],
      modelName: "gemini-3.6-flash-medium",
      transcriptPath: "/workspace/transcript.jsonl",
    };
    const identity = sessionIdentity({
      provider: "antigravity",
      nativeSessionId: common.conversationId,
    });
    async function hooks(plugin: string) {
      const cwd = join(bundles, plugin);
      const manifest = z
        .object({ name: z.string(), version: z.string() })
        .parse(await Bun.file(join(cwd, ".antigravity-plugin/plugin.json")).json());
      expect(manifest.name).toBe(plugin);
      expect(manifest.version).toMatch(/^\d+\.\d+\.\d+\+[a-f0-9]{12}$/u);
      const groups = z
        .record(z.string(), z.record(z.string(), z.array(z.unknown())))
        .parse(await Bun.file(join(cwd, "hooks.json")).json());
      return async (
        event: string,
        fields: Record<string, unknown> = {},
        malformed = false,
      ): Promise<unknown> => {
        const handlers = groups[plugin]?.[event];
        const handler = event.endsWith("ToolUse")
          ? z.tuple([toolMatcher]).parse(handlers)[0].hooks[0]
          : z.tuple([command]).parse(handlers)[0];
        const child = Bun.spawn(["sh", "-c", handler.command], {
          cwd,
          env: { ...host.env, BL_WORKSPACE: undefined, BL_RUN_REFERENCE: undefined },
          stdin: new Blob([JSON.stringify({ ...common, ...fields })]),
          stdout: "pipe",
          stderr: "pipe",
        });
        const [code, text, diagnostic] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect(code, diagnostic).toBe(0);
        if (malformed) expect(diagnostic).toContain("Botlake native adapter failed");
        else expect(diagnostic).toBe("");
        return JSON.parse(text);
      };
    }
    const observe = await hooks("botlake-identity");
    const mail = await hooks("botlake-mail");
    const opening = systemSteps.parse(await observe("SessionStart")).injectSteps[0].systemMessage
      .systemMessage;
    expect(opening).toContain(`--identity ${identity}`);
    expect(opening).toContain("Use this lake");
    for (const invocationNum of [0, 1])
      expect(
        await observe("PreInvocation", { invocationNum, lastUserInput: "Read the file" }),
      ).toEqual({});
    const step = {
      stepIdx: 19,
      toolCall: { name: "view_file", args: { AbsolutePath: "/workspace/missing" } },
    };
    expect(await observe("PreToolUse", step)).toEqual({ decision: "allow" });
    expect(await observe("PostToolUse", { ...step, error: "missing" })).toEqual({});
    expect(await observe("Stop", { fullyIdle: false })).toEqual({ decision: "stop" });
    expect(await observe("Stop", { fullyIdle: true, terminationReason: "model_stop" })).toEqual({
      decision: "stop",
    });
    const activity = await host.bl(lake, "agent", {
      command: "activity",
      operation: "list",
      id: identity,
    });
    expect(activity).toMatchObject({
      stream: {
        sessionId: common.conversationId,
        sessionPath: common.transcriptPath,
        endedAt: null,
      },
      events: [
        { kind: "session-started" },
        { kind: "turn-started" },
        { kind: "message", role: "user", summary: "Read the file" },
        { kind: "tool-started", tool: "view_file", callId: "19" },
        { kind: "tool-ended", callId: "19", outcome: "failed" },
        { kind: "turn-ended" },
      ],
    });
    expect(await host.bl(lake, "identity", { command: "show", identity })).toMatchObject({
      attributes: { "identity/activity": "idle", "identity/model": common.modelName },
    });

    expect(notices.parse(await mail("SessionStart")).injectSteps[0].ephemeralMessage).toContain(
      `Your Botlake mail identity is ${identity}`,
    );
    const { id } = z.object({ id: z.string() }).parse(
      await host.bl(lake, "mail", {
        command: "send",
        to: identity,
        subject: "Check the patch",
        body: "Not in hook output",
      }),
    );
    const notice = notices.parse(await mail("PreInvocation")).injectSteps[0].ephemeralMessage;
    expect(notice).toContain("Check the patch");
    expect(notice).not.toContain("Not in hook output");
    expect(await host.bl(lake, "mail", { command: "read", id })).toMatchObject({
      status: "delivered",
    });
    expect(await mail("PreInvocation")).toEqual({});
    expect(await mail("SessionStart", { workspacePaths: [host.dir] })).toEqual({});
    const noWorkspace = systemSteps.parse(await observe("SessionStart", { workspacePaths: [] }))
      .injectSteps[0].systemMessage.systemMessage;
    expect(noWorkspace).toContain(identity);
    expect(noWorkspace).not.toContain("Use this lake");
    expect(await observe("PreToolUse", {}, true)).toEqual({ decision: "allow" });
  } finally {
    await host.close();
  }
}, 60000);
