import { execFile } from "node:child_process";
import { appendFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

import { nativeWorkspace, sessionIdentity, type NativeSession } from "@botlake/native-session";
import { z } from "zod";

import { renderSummary } from "./summary.ts";

const inboxSchema = z.compile(
  z.object({
    messages: z.array(
      z.object({
        id: z.string(),
        from: z.string(),
        to: z.string(),
        subject: z.string(),
        urgent: z.boolean(),
      }),
    ),
    nextOffset: z.number().nullable(),
  }),
);
const receiptSchema = z.compile(z.object({ ids: z.array(z.string()), recorded: z.literal(true) }));

/** A native session's mailbox in the lake it reports to. */
export interface Mailbox {
  workspace: string;
  identity: string;
  env: NodeJS.ProcessEnv;
}

export interface MailPoll {
  notice: string;
  ids: string[];
}

type MailRequest =
  | { command: "list"; to: string; status: string[]; limit: number }
  | { command: "delivered"; ids: string[] }
  | { command: "wait"; timeoutSecs: number };

// Tool results wait on these calls, so a busy lake costs a turn two seconds at most.
const PROMPT_MS = 2000;
// One held request replaces this many seconds of polling. Kept short because a host that cannot
// cancel the wait (Claude after /clear, any host after a crash) is stuck with it until it ends.
const WAIT_SECS = 120;
const LEGACY_POLL_MS = 5000;
const unsupported = Symbol("unsupported");

/** `bl` gave no answer in time. The lake may only be busy; mail stays eligible. */
export class MailTimeout extends Error {}

/** Null outside any lake; the session then has no mailbox to announce. */
export async function openMailbox(
  session: NativeSession,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<Mailbox | null> {
  const workspace = await nativeWorkspace(cwd, env);
  return workspace === null ? null : { workspace, identity: sessionIdentity(session), env };
}

export function mailInstruction(box: Mailbox): string {
  return `Your Botlake mail identity is ${box.identity}. Load the mail primer once per session. Command:\n${callerCommand(box)} prime mail`;
}

/**
 * Poll lean summaries without changing delivery or acknowledgement state.
 * Null when the lake does not select Mail.
 */
export async function pollMail(box: Mailbox): Promise<MailPoll | null> {
  return summarize(
    box,
    await invokeMail(
      box,
      { command: "list", to: box.identity, status: ["sent"], limit: 100 },
      PROMPT_MS,
    ),
  );
}

/**
 * Hold one request until the lake has unannounced mail for this mailbox, or the wait budget ends
 * with an empty poll. Like pollMail, it changes no delivery state and is null without Mail.
 */
export async function waitMail(box: Mailbox, signal?: AbortSignal): Promise<MailPoll | null> {
  const response = await invokeMail(
    box,
    { command: "wait", timeoutSecs: WAIT_SECS },
    (WAIT_SECS + 15) * 1000,
    // Past the lake's own budget, so the wait ends as data before bl's deadline ends it as an error.
    ["--timeout", `${WAIT_SECS + 10}s`],
    signal,
  );
  if (response !== unsupported) return summarize(box, response);
  // A lake whose Mail predates wait: poll within the same budget.
  const until = Date.now() + WAIT_SECS * 1000;
  for (;;) {
    const poll = await pollMail(box);
    if (poll === null || poll.ids.length > 0 || Date.now() >= until) return poll;
    await delay(LEGACY_POLL_MS, undefined, { signal });
  }
}

export async function reportDelivery(box: Mailbox, ids: string[]): Promise<void> {
  receiptSchema.parse(await invokeMail(box, { command: "delivered", ids }, PROMPT_MS));
}

export async function traceMail(box: Mailbox, observation: Record<string, unknown>): Promise<void> {
  const trace = box.env["BL_MAIL_TRACE"];
  if (trace === undefined) return;
  try {
    await appendFile(
      trace,
      `${JSON.stringify({ at: Date.now(), identity: box.identity, ...observation })}\n`,
    );
  } catch (error) {
    // Optional experiment diagnostics must not consume or replace a mail notification.
    process.stderr.write(`Botlake mail trace unavailable: ${String(error)}\n`);
  }
}

function summarize(box: Mailbox, response: unknown): MailPoll | null {
  if (response === null) return null;
  const inbox = inboxSchema.parse(response);
  return {
    notice: renderSummary(inbox.messages, `${callerCommand(box)} mail inbox`),
    ids: inbox.messages.map((message) => message.id),
  };
}

/** Null when the lake does not select Mail; `unsupported` when its Mail predates wait. */
function invokeMail(
  box: Mailbox,
  request: MailRequest,
  timeoutMs: number,
  flags: string[] = [],
  signal?: AbortSignal,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile(
      box.env["BL_BIN"] ?? "bl",
      [
        "--workspace",
        box.workspace,
        "--identity",
        box.identity,
        ...flags,
        "--input",
        JSON.stringify(request),
        "mail",
      ],
      { env: box.env, timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024, signal },
      (error, stdout, stderr) => {
        if (error !== null) {
          if (stderr.includes("Unknown op: mail")) resolve(null);
          else if (request.command === "wait" && stderr.includes("error [validation]"))
            resolve(unsupported);
          // Node reports its own timeout kill as a bare "Command failed" with no output.
          else if (error.killed === true)
            reject(
              new MailTimeout(
                `bl mail ${request.command} gave no answer within ${timeoutMs / 1000}s`,
                { cause: error },
              ),
            );
          else
            reject(
              new Error(stderr.trim() === "" ? error.message : stderr.trim(), { cause: error }),
            );
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch (parseError) {
          reject(new Error("Invalid mailbox response", { cause: parseError }));
        }
      },
    );
  });
}

// Managed runs inherit BL_WORKSPACE and may work in another lake's checkout; direct sessions
// resolve their lake from the working directory.
function callerCommand(box: Mailbox): string {
  const binary = box.env["BL_BIN"] === undefined ? "bl" : '"$BL_BIN"';
  const workspace = box.env["BL_WORKSPACE"] === undefined ? "" : ' --workspace "$BL_WORKSPACE"';
  return `${binary}${workspace} --identity '${box.identity.replaceAll("'", "'\\''")}'`;
}
