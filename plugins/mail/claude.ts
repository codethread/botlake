// Claude Code hooks module (a "mod"): wakes an idle interactive session for new mail. It runs
// sandboxed without Node, so mailbox work goes through the bundled hook.ts beside it. Shipped as
// source: the engine statically checks how `register` and `$` are spelled, which bundling breaks.
import type { EngineInterface, Register } from "claude-code";

const RETRY_MS = 5000;
const MAX_RETRY_MS = 60_000;
const WARN_AFTER = 3;
// Above the hook's own wait budget, so the hook reports its outcome before the engine ends it.
const HOOK_TIMEOUT_MS = 150_000;

interface IdleWindow {
  timer?: { cancel(): void };
}

let interactive = false;
let idle: IdleWindow | undefined;
// Settles once a woken turn's handoff is recorded, or abandoned.
let receipt: Promise<void> = Promise.resolve();
// If recording delivery failed, retry the receipt without starting another paid turn.
let handedOff: { sessionId: string; ids: string[] } | undefined;

function stopIdle(): void {
  idle?.timer?.cancel();
  idle = undefined;
}

export const register: Register = (on) => {
  on("session.start", (_, e, next) => {
    stopIdle();
    // Headless runs (`claude -p`, the SDK, managed seats) have no idle prompt to wake.
    interactive = e.isInteractive;
    return next(e);
  });
  on("turn.start", (_, e, next) => {
    if (e.agentId === undefined) stopIdle();
    return next(e);
  });
  on("turn.complete", async ($, e, next) => {
    if (
      interactive &&
      e.agentId === undefined &&
      (e.reason === "answer" || e.reason === "refusal")
    ) {
      stopIdle();
      const current: IdleWindow = {};
      idle = current;
      try {
        const turnEndedAt = await $.clock.now();
        const sessionId = await $.session.id();
        if (idle === current)
          current.timer = $.clock.after(
            0,
            () => void watchIdle($, current, sessionId, turnEndedAt),
          );
      } catch (error) {
        $.ui.log(`Mail unavailable: ${String(error)}`);
      }
    }
    return next(e);
  });
  // The PostToolUse command hook polls after each tool. Hold tools until the idle handoff
  // receipt is recorded so they don't announce the same batch. `receipt` never rejects.
  on("tool.call", async (_, e, next) => {
    await receipt;
    return next(e);
  });
};

async function watchIdle(
  $: EngineInterface,
  current: IdleWindow,
  sessionId: string,
  turnEndedAt: number,
): Promise<void> {
  const isCurrent = async () =>
    idle === current && (await $.session.id()) === sessionId && idle === current;
  let expiresAt: number | null | undefined;
  let misses = 0;
  try {
    const session = { session_id: sessionId, cwd: await $.session.cwd() };
    const check = async () => {
      expiresAt ??= await deadlineFor($, session, turnEndedAt);
      const deadline = expiresAt;
      if (deadline === null || (await $.clock.now()) >= deadline || idle !== current) return false;
      const { inactive, ids, notice } = await hook($, {
        hook_event_name: "IdleMail",
        ...session,
        expiresAt: deadline,
      });
      if (inactive === true) return false;
      if (
        !Array.isArray(ids) ||
        !ids.every((id): id is string => typeof id === "string") ||
        typeof notice !== "string"
      )
        throw new Error("Invalid idle mail wait result");
      // /clear can change the session without session.start. A new root turn can also
      // start while the wait or either engine call is in flight.
      if (
        ids.length > 0 &&
        (await isCurrent()) &&
        (await $.clock.now()) < deadline &&
        idle === current
      ) {
        await handOff($, session, ids, notice);
      }
      return true;
    };
    while (await isCurrent()) {
      try {
        if (!(await check())) return;
        misses = 0;
      } catch (error) {
        if (!(await isCurrent())) return;
        misses += 1;
        if (misses === WARN_AFTER) $.ui.log(`Mail unavailable: ${String(error)}`);
      }
      const pause = Math.min(
        RETRY_MS * 2 ** misses,
        MAX_RETRY_MS,
        (expiresAt ?? Infinity) - (await $.clock.now()),
      );
      if (pause <= 0 || idle !== current) return;
      await $.clock.sleep(pause);
    }
  } catch (error) {
    if (idle === current) $.ui.log(`Mail unavailable: ${String(error)}`);
  }
}

async function deadlineFor(
  $: EngineInterface,
  session: { session_id: string; cwd: string },
  turnEndedAt: number,
): Promise<number | null> {
  const { inactive, expiresAt } = await hook($, {
    hook_event_name: "IdleMailDeadline",
    ...session,
    turnEndedAt,
  });
  if (inactive === true) return null;
  if (typeof expiresAt !== "number") throw new Error("Missing idle wake deadline");
  return expiresAt;
}

async function handOff(
  $: EngineInterface,
  session: { session_id: string; cwd: string },
  ids: string[],
  notice: string,
): Promise<void> {
  const previous = handedOff?.sessionId === session.session_id ? handedOff.ids : [];
  if (ids.some((id) => !previous.includes(id))) {
    // Queued until idle; resolves as the woken turn starts.
    const submitted = await $.prompt.submit({ text: notice });
    if (submitted.drop !== undefined) return;
    handedOff = { sessionId: session.session_id, ids };
  }
  const delivered = hook($, { hook_event_name: "IdleMailDelivered", ...session, ids });
  receipt = delivered.then(ignore, ignore);
  await delivered;
  handedOff = undefined;
}

async function hook(
  $: EngineInterface,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { exitCode, stdout, stderr } = await $.process.run(
    ["bun", `${$.plugin.root}/hook.ts`, "claude"],
    { stdin: JSON.stringify(input), timeoutMs: HOOK_TIMEOUT_MS },
  );
  if (exitCode !== 0) throw new Error(`hook.ts exited ${exitCode}: ${stderr.trim()}`);
  const reply: unknown = JSON.parse(stdout);
  if (typeof reply !== "object" || reply === null)
    throw new Error(`Unexpected hook reply: ${stdout}`);
  if ("systemMessage" in reply) throw new Error(String(reply.systemMessage));
  if ("busy" in reply && reply.busy === true) throw new Error("the lake did not answer in time");
  return { ...reply };
}

function ignore(): void {}
