// Claude Code hooks module (a "mod"): wakes an idle interactive session for new mail. It runs
// sandboxed without Node, so mailbox work goes through the bundled hook.ts beside it. Shipped as
// source: the engine statically checks how `register` and `$` are spelled, which bundling breaks.
import type { EngineInterface, Register } from "claude-code";

const IDLE_POLL_MS = 5000;

type IdleReply = { inactive: true } | { ids: string[]; notice: string };

// Module state lives for one load; a reload runs session.start, and so the watcher, again.
let turnRunning = false;
// Settles once a woken turn's handoff is recorded, or abandoned.
let receipt: Promise<void> = Promise.resolve();
// If recording delivery failed, retry the receipt without starting another paid turn.
let handedOff: string[] = [];
let warned = false;

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
    if (e.isInteractive) $.clock.after(IDLE_POLL_MS, () => void tick($));
    return next(e);
  });
};

async function tick($: EngineInterface): Promise<void> {
  try {
    if (!turnRunning && (await check($)) === "stop") return;
    warned = false;
  } catch (error) {
    if (!warned) $.ui.log(`Mail unavailable: ${String(error)}`);
    warned = true;
  }
  $.clock.after(IDLE_POLL_MS, () => void tick($));
}

async function check($: EngineInterface): Promise<"stop" | "continue"> {
  // Read each time: /clear starts a new session id without another session.start.
  const session = { session_id: await $.session.id(), cwd: await $.session.cwd() };
  const poll = await hook($, { hook_event_name: "IdleMail", ...session });
  if ("inactive" in poll) return "stop";
  // The person may have submitted a prompt during the poll.
  if (turnRunning || poll.ids.length === 0) return "continue";
  if (poll.ids.some((id) => !handedOff.includes(id))) {
    // Queued until idle; resolves as the woken turn starts.
    const submitted = await $.prompt.submit({ text: poll.notice });
    if (submitted.drop !== undefined) return "continue";
    handedOff = poll.ids;
  }
  const delivered = hook($, { hook_event_name: "IdleMailDelivered", ...session, ids: poll.ids });
  receipt = delivered.then(ignore, ignore);
  await delivered;
  handedOff = [];
  return "continue";
}

async function hook($: EngineInterface, input: Record<string, unknown>): Promise<IdleReply> {
  const { exitCode, stdout, stderr } = await $.process.run(
    ["bun", `${$.plugin.root}/hook.ts`, "claude"],
    { stdin: JSON.stringify(input), timeoutMs: 10_000 },
  );
  if (exitCode !== 0) throw new Error(`hook.ts exited ${exitCode}: ${stderr.trim()}`);
  const reply: unknown = JSON.parse(stdout);
  if (typeof reply !== "object" || reply === null)
    throw new Error(`Unexpected hook reply: ${stdout}`);
  if ("systemMessage" in reply) throw new Error(String(reply.systemMessage));
  if ("inactive" in reply) return { inactive: true };
  if ("ids" in reply && "notice" in reply && Array.isArray(reply.ids))
    return { ids: reply.ids.map(String), notice: String(reply.notice) };
  return { ids: [], notice: "" };
}

function ignore(): void {}
