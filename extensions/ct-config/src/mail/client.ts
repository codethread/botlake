import { execFile } from "node:child_process";
import { appendFile } from "node:fs/promises";

import { z } from "zod";

import { renderSummary } from "./summary.ts";

const configurationSchema = z.compile(
  z.object({
    BL_WORKSPACE: z.string().min(1),
    BL_BIN: z.string().min(1).default("bl"),
    BL_MAIL_TRACE: z.string().min(1).optional(),
  }),
);
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

export type MailConfig = z.infer<typeof configurationSchema>;

export interface MailPoll {
  notice: string;
  ids: string[];
}

type MailRequest =
  | { command: "list"; to: string; status: string[]; limit: number }
  | { command: "delivered"; ids: string[] };

export function loadMailConfig(env: NodeJS.ProcessEnv): MailConfig {
  return configurationSchema.parse(env);
}

export function mailCommand(config: MailConfig, identity: string): string {
  return `${callerCommand(config, identity)} mail`;
}

export function mailInstruction(config: MailConfig, identity: string): string {
  return `Your Botlake mail identity is ${identity}. Load the mail primer once per session. Command:\n${callerCommand(config, identity)} prime mail`;
}

/** Poll lean summaries without changing delivery or acknowledgement state. */
export async function pollMail(
  config: MailConfig,
  identity: string,
  readInbox: () => Promise<unknown>,
): Promise<MailPoll> {
  const inbox = inboxSchema.parse(await readInbox());
  return {
    notice: renderSummary(inbox.messages, `${mailCommand(config, identity)} inbox`),
    ids: inbox.messages.map((message) => message.id),
  };
}

export function inboxReader(
  config: MailConfig,
  identity: string,
  env: NodeJS.ProcessEnv,
): () => Promise<unknown> {
  return () =>
    invokeMail(
      config,
      identity,
      { command: "list", to: identity, status: ["sent"], limit: 100 },
      env,
    );
}

export async function reportDelivery(
  config: MailConfig,
  identity: string,
  ids: string[],
  env: NodeJS.ProcessEnv,
): Promise<void> {
  receiptSchema.parse(await invokeMail(config, identity, { command: "delivered", ids }, env));
}

function invokeMail(
  config: MailConfig,
  identity: string,
  request: MailRequest,
  env: NodeJS.ProcessEnv,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile(
      config.BL_BIN,
      [
        "--workspace",
        config.BL_WORKSPACE,
        "--identity",
        identity,
        "--input",
        JSON.stringify(request),
        "mail",
      ],
      { env, timeout: 2000, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout) => {
        if (error !== null) {
          reject(new Error(error.message, { cause: error }));
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

export async function traceMail(
  config: MailConfig,
  observation: Record<string, unknown>,
): Promise<void> {
  if (config.BL_MAIL_TRACE === undefined) return;
  try {
    await appendFile(
      config.BL_MAIL_TRACE,
      `${JSON.stringify({ at: Date.now(), ...observation })}\n`,
    );
  } catch (error) {
    // Optional experiment diagnostics must not consume or replace a mail notification.
    process.stderr.write(`Botlake mail trace unavailable: ${String(error)}\n`);
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function callerCommand(config: MailConfig, identity: string): string {
  const binary = config.BL_BIN === "bl" ? "bl" : '"$BL_BIN"';
  return `${binary} --workspace "$BL_WORKSPACE" --identity ${shellQuote(identity)}`;
}
