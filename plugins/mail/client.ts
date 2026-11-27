import { execFile } from "node:child_process";
import { appendFile } from "node:fs/promises";

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
  | { command: "idle-window"; provider: string }
  | { command: "list"; to: string; status: string[]; limit: number }
  | { command: "delivered"; ids: string[] }
  | { command: "wait"; timeoutSecs: number };

// Tool results wait on these calls, so a busy lake costs a turn two seconds at most.
const PROMPT_MS = 2000;
// One held request replaces this many seconds of polling. Kept short because a host that cannot
// cancel the wait (Claude after /clear, any host after a crash) is stuck with it until it ends.
const WAIT_SECS = 120;
const windowSchema = z.object({ seconds: z.number().int().nonnegative() });

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

/** Query the session's lake; the window starts at turn completion, not at this request. */
export async function idleWakeDeadline(
  box: Mailbox,
  provider: string,
  turnEndedAt: number,
): Promise<number | null> {
  const result = await invokeMail(box, { command: "idle-window", provider }, PROMPT_MS);
  return result === null ? null : turnEndedAt + windowSchema.parse(result).seconds * 1000;
}

/** Wait at most one budget within the wake window. Callers recheck expiry at handoff. */
export async function waitMail(
  box: Mailbox,
  signal?: AbortSignal,
  expiresAt = Infinity,
): Promise<MailPoll | null> {
  const remaining = expiresAt - Date.now();
  if (remaining <= 0) return { ids: [], notice: "" };
  const timeoutSecs = Math.min(WAIT_SECS, Math.ceil(remaining / 1000));
  const response = await invokeMail(
    box,
    { command: "wait", timeoutSecs },
    (timeoutSecs + 15) * 1000,
    ["--timeout", `${timeoutSecs + 10}s`],
    signal,
  );
  return summarize(box, response);
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

/** Null when the lake does not select Mail. */
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
