import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { z } from "zod";

import type { system } from "../../tests/blackbox/fixtures/system.ts";

const root = resolve(import.meta.dir, "../..");
const traceSchema = z.object({
  event: z.string(),
  identity: z.string(),
  notice: z.string().optional(),
});
const inboxSchema = z.object({
  messages: z.array(
    z.object({
      id: z.string(),
      from: z.string(),
      to: z.string(),
      subject: z.string(),
      body: z.string(),
      urgent: z.boolean(),
      status: z.string(),
      repliesTo: z.string().nullable(),
      deliveredAt: z.number().nullable(),
      acknowledgedAt: z.number().nullable(),
    }),
  ),
});

type Fixture = Awaited<ReturnType<typeof system>>;
type Peer = {
  name: "codex" | "pi";
  dir: string;
  trace: string;
  child: Bun.Subprocess;
  identity?: string;
};

export async function runPeers(
  fixture: Fixture,
  workspace: string,
  output: string,
): Promise<unknown> {
  const pairOutput = join(output, "peers");
  await mkdir(pairOutput, { recursive: true });

  const peers: Peer[] = [];
  const deadline = Date.now() + 120_000;
  const killTimer = setTimeout(() => {
    for (const peer of peers) peer.child.kill();
  }, 120_000);

  try {
    const codex = await launchPeer("codex", fixture, workspace, pairOutput);
    peers.push(codex);
    const pi = await launchPeer("pi", fixture, workspace, pairOutput);
    peers.push(pi);

    await Promise.all(
      peers.map(async (peer) => {
        peer.identity = await started(peer.trace, peer.child, deadline);
        await waitFor(
          () => Bun.file(join(peer.dir, "ready")).exists(),
          peer.child,
          `${peer.name} initial barrier`,
          deadline,
        );
      }),
    );

    const codexIdentity = z.string().parse(codex.identity);
    const piIdentity = z.string().parse(pi.identity);
    if (codexIdentity === piIdentity) throw new Error("Peer sessions produced the same identity");

    const codexToken = `CODEX-${crypto.randomUUID()}`;
    const piToken = `PI-${crypto.randomUUID()}`;
    await Promise.all([
      writeAssignment(codex, {
        ownIdentity: codexIdentity,
        recipientIdentity: piIdentity,
        token: codexToken,
        urgent: true,
      }),
      writeAssignment(pi, {
        ownIdentity: piIdentity,
        recipientIdentity: codexIdentity,
        token: piToken,
        urgent: false,
      }),
    ]);
    await Promise.all(peers.map((peer) => Bun.write(join(peer.dir, "release"), "release")));

    const exitCodes = await Promise.all(peers.map((peer) => peer.child.exited));

    const [codexInbox, piInbox] = await Promise.all([
      mailbox(fixture, workspace, codexIdentity),
      mailbox(fixture, workspace, piIdentity),
    ]);
    const rows = [...codexInbox.messages, ...piInbox.messages].map((m) => ({
      id: m.id,
      sender: m.from,
      recipient: m.to,
      subject: m.subject,
      body: m.body,
      urgent: Number(m.urgent),
      status: m.status,
      delivered_at: m.deliveredAt,
      acknowledged_at: m.acknowledgedAt,
    }));
    const codexTrace = await traceEvents(codex.trace);
    const piTrace = await traceEvents(pi.trace);

    const evidence = {
      identities: { codex: codexIdentity, pi: piIdentity, independent: true },
      directions: {
        piToCodex: directionEvidence({
          rows,
          sender: piIdentity,
          recipient: codexIdentity,
          token: piToken,
          urgent: false,
          senderInbox: piInbox.messages,
        }),
        codexToPi: directionEvidence({
          rows,
          sender: codexIdentity,
          recipient: piIdentity,
          token: codexToken,
          urgent: true,
          senderInbox: codexInbox.messages,
        }),
      },
      processes: { codex: exitCodes[0], pi: exitCodes[1] },
      traces: {
        codex: summarizeTrace(codexTrace),
        pi: summarizeTrace(piTrace),
      },
      logs: pairOutput,
    };
    await Bun.write(join(pairOutput, "results.json"), JSON.stringify(evidence, null, 2));
    for (const direction of Object.values(evidence.directions)) {
      assert.equal(direction.sent, true);
      assert.equal(direction.urgencyMatches, true);
      assert.equal(direction.deliveryRecorded, true);
      assert.equal(direction.recipientReadAndAcked, true);
      assert.equal(direction.verifiedTokenReply, true);
      assert.equal(direction.replyAcknowledged, true);
    }
    assert.deepEqual(exitCodes, [0, 0]);
    return evidence;
  } finally {
    clearTimeout(killTimer);
    for (const peer of peers) {
      if (peer.child.exitCode === null) peer.child.kill();
    }
    await Promise.all(peers.map((peer) => peer.child.exited.catch(() => -1)));
  }
}

async function launchPeer(
  name: Peer["name"],
  fixture: Fixture,
  workspace: string,
  output: string,
): Promise<Peer> {
  const dir = join(workspace, `peer-${name}`);
  const trace = join(output, `${name}.trace.jsonl`);
  await mkdir(dir, { recursive: true });
  await Bun.write(trace, "");
  await Bun.write(
    join(dir, "barrier.ts"),
    `await Bun.write("ready", "ready");
const deadline = Date.now() + 90000;
while (!(await Bun.file("release").exists())) {
  if (Date.now() > deadline) throw new Error("release barrier timeout");
  await Bun.sleep(50);
}
console.log(await Bun.file("assignment.txt").text());
`,
  );

  const env = {
    ...fixture.env,
    BL_WORKSPACE: workspace,
    BL_MAIL_TRACE: trace,
    BL_RUN_REFERENCE: undefined,
    BL_ACTOR: undefined,
  };
  const prompt =
    "This is an authorized disposable two-agent integration experiment. Do not delegate, inspect implementation files, or contact the other process except through the mail commands in your assignment. Follow the startup instruction to load the Botlake mail primer, then run `bun barrier.ts` first. Its output is your complete assignment. An explicit request to reply with a token is authorized; reproduce only the requested token. Finish after the assignment is complete.";
  const hookCommand = `bun ${shellQuote(join(root, "plugins/mail/hook.ts"))} codex`;
  const hooks = `[ { hooks = [ { type = "command", command = ${JSON.stringify(hookCommand)}, timeout = 5, additionalContextLimit = 2000 } ] } ]`;
  const command =
    name === "codex"
      ? [
          "codex",
          "--no-daemon",
          "exec",
          "--ignore-user-config",
          "--ignore-rules",
          "--skip-git-repo-check",
          "--dangerously-bypass-hook-trust",
          "--sandbox",
          "danger-full-access",
          "--model",
          "gpt-6-luna",
          "-c",
          'model_reasoning_effort="low"',
          "-c",
          "features.hooks=true",
          "-c",
          `hooks.SessionStart=${hooks}`,
          "-c",
          `hooks.PostToolUse=${hooks}`,
          "--json",
          prompt,
        ]
      : [
          process.env["BL_MAIL_PI_BIN"] ?? "pi",
          "--print",
          "--mode",
          "json",
          "--model",
          "openai-codex/gpt-6-luna",
          "--thinking",
          "low",
          "--no-extensions",
          "--no-skills",
          "--no-prompt-templates",
          "--no-context-files",
          "--no-mcp",
          "-e",
          join(root, "plugins/mail/pi.ts"),
          prompt,
        ];
  const child = Bun.spawn(command, {
    cwd: dir,
    env,
    stdout: Bun.file(join(output, `${name}.stdout.jsonl`)),
    stderr: Bun.file(join(output, `${name}.stderr.log`)),
  });
  return { name, dir, trace, child };
}

async function writeAssignment(
  peer: Peer,
  assignment: {
    ownIdentity: string;
    recipientIdentity: string;
    token: string;
    urgent: boolean;
  },
): Promise<void> {
  const urgentFlag = assignment.urgent ? " --urgent" : "";
  const text = `Your identity is ${assignment.ownIdentity}.
Send exactly one ${assignment.urgent ? "urgent" : "normal"} message to ${assignment.recipientIdentity} by running:
"$BL_BIN" --workspace "$BL_WORKSPACE" --identity ${shellQuote(assignment.ownIdentity)} mail send ${shellQuote(assignment.recipientIdentity)} ${shellQuote("Peer exchange")} ${shellQuote(`Reply with body ${assignment.token}`)}${urgentFlag}
Then wait for mail using the existing Batteries await command with query mail-pending, params containing recipient set to your identity, --min-count 1 and --timeout-secs 30. Inspect reason; if timeout, wait again. Do not treat timeout as completion.
After that command completes, use "$BL_BIN" --workspace "$BL_WORKSPACE" --identity ${shellQuote(assignment.ownIdentity)} to inspect your inbox. Read the peer's original request (repliesTo is null), acknowledge it according to the primer, then use mail reply ID BODY with exactly its requested token. Replies keep the original subject and identify their parent with repliesTo; do not invent a REPLY subject. Await and read the reply whose repliesTo matches your outgoing original ID, verify that its body matches your own token, acknowledge it, then finish. Acknowledge seen messages before waiting again so mail-pending does not repeatedly match them.
`;
  await Bun.write(join(peer.dir, "assignment.txt"), text);
}

async function mailbox(fixture: Fixture, workspace: string, identity: string) {
  return inboxSchema.parse(
    await fixture.cli([
      "--workspace",
      workspace,
      "--identity",
      identity,
      "mail",
      "list",
      "--to",
      identity,
      "--lean=false",
    ]),
  );
}

function directionEvidence(input: {
  rows: {
    id: string;
    sender: string;
    recipient: string;
    subject: string;
    body: string;
    urgent: number;
    status: string;
    delivered_at: number | null;
    acknowledged_at: number | null;
  }[];
  sender: string;
  recipient: string;
  token: string;
  urgent: boolean;
  senderInbox: z.infer<typeof inboxSchema>["messages"];
}) {
  const sent = input.rows.find(
    (row) =>
      row.sender === input.sender &&
      row.recipient === input.recipient &&
      row.body === `Reply with body ${input.token}`,
  );
  const reply = input.senderInbox.find(
    (message) =>
      message.from === input.recipient &&
      message.repliesTo === sent?.id &&
      message.body === input.token,
  );
  return {
    sent: sent !== undefined,
    urgent: input.urgent,
    urgencyMatches: sent?.urgent === Number(input.urgent),
    deliveryRecorded:
      sent?.delivered_at !== null && sent?.delivered_at !== undefined && sent.status !== "sent",
    recipientReadAndAcked: sent?.acknowledged_at !== null && sent?.acknowledged_at !== undefined,
    verifiedTokenReply: reply !== undefined,
    replyAcknowledged: reply?.status === "acknowledged",
    message: sent,
    reply,
  };
}

async function started(path: string, child: Bun.Subprocess, deadline: number): Promise<string> {
  let identity: string | undefined;
  await waitFor(
    async () => {
      for (const event of await traceEvents(path)) {
        if (event.event === "session-start") identity = event.identity;
      }
      return identity !== undefined;
    },
    child,
    "session-start hook",
    deadline,
  );
  return z.string().parse(identity);
}

async function traceEvents(path: string): Promise<z.infer<typeof traceSchema>[]> {
  return (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => traceSchema.parse(JSON.parse(line)));
}

function summarizeTrace(events: z.infer<typeof traceSchema>[]) {
  return {
    events: events.map((event) => event.event),
    notices: events.flatMap((event) => (event.notice === undefined ? [] : [event.notice])),
  };
}

async function waitFor(
  check: () => Promise<boolean>,
  child: Bun.Subprocess,
  label: string,
  deadline: number,
): Promise<void> {
  while (!(await check())) {
    if (child.exitCode !== null)
      throw new Error(`Process exited ${child.exitCode} before ${label}`);
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await Bun.sleep(50);
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
