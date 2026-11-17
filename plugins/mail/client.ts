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
  | { command: "list"; to: string; status: string[]; limit: number }
  | { command: "delivered"; ids: string[] };

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
  const response = await invokeMail(box, {
    command: "list",
    to: box.identity,
    status: ["sent"],
    limit: 100,
  });
  if (response === null) return null;
  const inbox = inboxSchema.parse(response);
  return {
    notice: renderSummary(inbox.messages, `${callerCommand(box)} mail inbox`),
    ids: inbox.messages.map((message) => message.id),
  };
}

export async function reportDelivery(box: Mailbox, ids: string[]): Promise<void> {
  receiptSchema.parse(await invokeMail(box, { command: "delivered", ids }));
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

function invokeMail(box: Mailbox, request: MailRequest): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile(
      box.env["BL_BIN"] ?? "bl",
      [
        "--workspace",
        box.workspace,
        "--identity",
        box.identity,
        "--input",
        JSON.stringify(request),
        "mail",
      ],
      { env: box.env, timeout: 2000, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error !== null) {
          if (stderr.includes("Unknown op: mail")) resolve(null);
          else reject(new Error(error.message, { cause: error }));
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
