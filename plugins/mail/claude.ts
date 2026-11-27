// Claude Code hooks module (a "mod"): wakes an idle interactive session for new mail. It runs
// sandboxed without Node, so mailbox work goes through the bundled hook.ts beside it. Shipped as
// source: the engine statically checks how `register` and `$` are spelled, which bundling breaks.
import type { EngineInterface, Register } from "claude-code";

// The pause between waits, and the first step of the backoff after a failed one.
const RETRY_MS = 5000;
const MAX_RETRY_MS = 60_000;
// A lake restart or a busy machine costs a wait or two; only a lasting failure is worth a line.
const WARN_AFTER = 3;
// Above the hook's own wait budget, so the hook reports its outcome before the engine ends it.
const HOOK_TIMEOUT_MS = 150_000;

type IdleReply = { inactive: true } | { busy: true } | { ids: string[]; notice: string };

// Module state lives for one load; a reload runs session.start, and so the watcher, again.
let turnRunning = false;
// Settles once a woken turn's handoff is recorded, or abandoned.
let receipt: Promise<void> = Promise.resolve();
// If recording delivery failed, retry the receipt without starting another paid turn.
let handedOff: string[] = [];
let misses = 0;
// The first check is a quick poll. If it fails outright (no Bun, a broken install) the watcher
// stops instead of retrying forever; once it has answered, checks hold a wait open and failures,
// such as a restarting lake, keep retrying.
let polled = false;

export const register: Register = (on) => {
  on("turn.start", (_, e, next) => {
    if (e.agentId === undefined) turnRunning = true;
    return next(e);
  });
  on("turn.complete", (_, e, next) => {
    if (e.agentId === undefined) turnRunning = false;
    return next(e);
  });
  // The PostToolUse command hook polls after each tool; holding tools until the receipt is
  // recorded keeps it from announcing the batch that woke this turn a second time. `receipt`
  // never rejects, so the gate cannot fail before `next`.
  on("tool.call", async (_, e, next) => {
    await receipt;
    return next(e);
  });
  on("session.start", ($, e, next) => {
    // Headless runs (`claude -p`, the SDK, managed seats) have no idle prompt to wake.
    if (e.isInteractive) $.clock.after(RETRY_MS, () => void tick($));
    return next(e);
  });
};

async function tick($: EngineInterface): Promise<void> {
  try {
    // A wait already held when a turn starts simply ends unused; none begins during a turn.
    if (!turnRunning) {
      const outcome = await check($);
      if (outcome === "stop") return;
      if (outcome === "busy") miss($, "the lake did not answer in time");
      else {
        polled = true;
        misses = 0;
      }
    }
  } catch (error) {
    if (!polled) {
      $.ui.log(`Mail unavailable: ${String(error)}`);
      return;
    }
    miss($, String(error));
  }
  $.clock.after(Math.min(RETRY_MS * 2 ** misses, MAX_RETRY_MS), () => void tick($));
}

function miss($: EngineInterface, reason: string): void {
  misses += 1;
  if (misses === WARN_AFTER) $.ui.log(`Mail unavailable: ${reason}`);
}

async function check($: EngineInterface): Promise<"stop" | "busy" | "continue"> {
  // Read each time: /clear starts a new session id without another session.start.
  const session = { session_id: await $.session.id(), cwd: await $.session.cwd() };
  const poll = await hook($, { hook_event_name: "IdleMail", ...session, hold: polled });
  if ("inactive" in poll) return "stop";
  if ("busy" in poll) return "busy";
  // The person may have submitted a prompt during the wait.
  if (turnRunning || poll.ids.length === 0) return "continue";
  if (poll.ids.some((id) => !handedOff.includes(id))) {
    // Queued until idle; resolves as the woken turn starts.
    const submitted = await $.prompt.submit({ text: poll.notice });
    if (submitted.drop !== undefined) return "continue";
    handedOff = poll.ids;
  }
  const delivered = hook($, { hook_event_name: "IdleMailDelivered", ...session, ids: poll.ids });
  receipt = delivered.then(ignore, ignore);
  if ("busy" in (await delivered)) return "busy";
  handedOff = [];
  return "continue";
}

async function hook($: EngineInterface, input: Record<string, unknown>): Promise<IdleReply> {
  const { exitCode, stdout, stderr } = await $.process.run(
    ["bun", `${$.plugin.root}/hook.ts`, "claude"],
    { stdin: JSON.stringify(input), timeoutMs: HOOK_TIMEOUT_MS },
  );
  if (exitCode !== 0) throw new Error(`hook.ts exited ${exitCode}: ${stderr.trim()}`);
  const reply: unknown = JSON.parse(stdout);
  if (typeof reply !== "object" || reply === null)
    throw new Error(`Unexpected hook reply: ${stdout}`);
  if ("systemMessage" in reply) throw new Error(String(reply.systemMessage));
  if ("inactive" in reply) return { inactive: true };
  if ("busy" in reply) return { busy: true };
  if ("ids" in reply && "notice" in reply && Array.isArray(reply.ids))
    return { ids: reply.ids.map(String), notice: String(reply.notice) };
  return { ids: [], notice: "" };
}

function ignore(): void {}
