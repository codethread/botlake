import { registerNative } from "./client.ts";

interface PiContext {
  cwd: string;
  sessionManager: { getSessionId(): string };
  model?: { id: string };
  thinkingLevel?: string;
}
interface PiApi {
  on(event: "session_start", handler: (event: unknown, ctx: PiContext) => Promise<void>): void;
  on(event: "session_shutdown", handler: () => void): void;
  on(
    event: "before_agent_start",
    handler: (event: { systemPrompt: string }) => { systemPrompt: string } | undefined,
  ): void;
  on(event: "input", handler: () => { action: "handled" } | undefined): void;
  on(
    event: "before_provider_request",
    handler: (event: unknown, ctx: { abort(): void }) => void,
  ): void;
}
export default function identityExtension(pi: PiApi): void {
  let blocked = true;
  let instruction: string | undefined;
  let parent: { session: string; identity: string } | undefined;
  let managedSession: string | undefined;
  let owningWorkspace: string | undefined;
  pi.on("session_start", async (_, ctx) => {
    blocked = true;
    instruction = undefined;
    const session = ctx.sessionManager.getSessionId();
    const child = parent !== undefined && parent.session !== session;
    if (managedSession === undefined && process.env["BOTLAKE_RUN_ID"] !== undefined) {
      managedSession = session;
      owningWorkspace = process.env["BOTLAKE_WORKSPACE"];
    }
    const result = await registerNative({
      provider: "pi",
      nativeSessionId: session,
      cwd: ctx.cwd,
      unmanaged: managedSession !== undefined && session !== managedSession,
      ...(child && parent !== undefined ? { parentIdentity: parent.identity } : {}),
      ...(owningWorkspace === undefined ? {} : { workspace: owningWorkspace }),
      ...(ctx.model === undefined ? {} : { model: ctx.model.id }),
      ...(ctx.thinkingLevel === undefined ? {} : { thinkingLevel: ctx.thinkingLevel }),
    });
    if (result !== null) {
      instruction = result.instruction;
      parent = { session, identity: result.identity };
    }
    blocked = false;
  });
  pi.on("session_shutdown", () => {
    blocked = true;
    instruction = undefined;
  });
  pi.on("input", () => (blocked ? { action: "handled" } : undefined));
  pi.on("before_provider_request", (_, ctx) => {
    if (blocked) {
      ctx.abort();
      throw new Error("Native identity startup has not completed");
    }
  });
  pi.on("before_agent_start", (event) =>
    instruction === undefined
      ? undefined
      : { systemPrompt: `${event.systemPrompt}\n\n${instruction}` },
  );
}
