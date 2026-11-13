import { mkdir, readFile, cp } from "node:fs/promises";
import { join, resolve } from "node:path";

import { z } from "zod";

import { system } from "../../tests/blackbox/fixtures/system.ts";
import { call, mailLake } from "./fixture.ts";

const root = resolve(import.meta.dir, "../..");
const scenarioSchema = z.enum(["pingpong", "fanin", "orchestrator"]);
const selection = z
  .enum(["all", ...scenarioSchema.options])
  .default("all")
  .parse(Bun.argv[2]);
const waiting = z.enum(["natural", "deadline"]).default("natural").parse(Bun.argv[3]);
const output = join(root, "out/mail-graph/stress", new Date().toISOString().replaceAll(":", "-"));
const startupSchema = z.object({
  event: z.string(),
  identity: z.string(),
  sessionId: z.string().optional(),
});
const pageSchema = z.object({
  messages: z.array(
    z.object({
      id: z.string(),
      from: z.string(),
      to: z.string(),
      subject: z.string(),
      body: z.string(),
      urgent: z.boolean(),
      status: z.string(),
      sentAt: z.number(),
      deliveredAt: z.number().nullable(),
      acknowledgedAt: z.number().nullable(),
    }),
  ),
  nextOffset: z.number().nullable(),
});
const eventSchema = z
  .object({
    type: z.string(),
    thread_id: z.string().optional(),
    message: z
      .object({
        role: z.string(),
        content: z.array(z.object({ type: z.string(), text: z.string().optional() }).loose()),
      })
      .loose()
      .optional(),
  })
  .loose();
type Fixture = Awaited<ReturnType<typeof system>>;
type Scenario = z.infer<typeof scenarioSchema>;
interface Session {
  name: string;
  provider: "codex" | "pi";
  dir: string;
  logs: string;
  trace: string;
  session: string;
  identity: string;
  env: Record<string, string | undefined>;
}
interface Participant extends Session {
  child: Bun.Subprocess;
  timedOut: boolean;
}
interface Expected {
  from: string;
  to: string;
  subject: string;
  body: string;
  urgent: boolean;
}

await mkdir(output, { recursive: true });
console.log(JSON.stringify({ event: "starting", output, selection, waiting }));
const testSystem = await system();
try {
  const scenarios = selection === "all" ? scenarioSchema.options : [selection];
  const results = await Promise.allSettled(scenarios.map((name) => runScenario(testSystem, name)));
  await Bun.write(join(output, "results.json"), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ event: "finished", output, results }));
} finally {
  await testSystem.close();
  await Bun.write(
    join(output, "cleanup.json"),
    JSON.stringify({ removed: testSystem.dir, at: new Date().toISOString() }),
  );
}

async function runScenario(fixture: Fixture, name: Scenario) {
  const logs = join(output, name);
  await mkdir(logs, { recursive: true });
  const workspace = await mailLake(fixture, `stress-${name}`);
  const names =
    name === "pingpong"
      ? ["initiator", "responder"]
      : name === "fanin"
        ? ["collector", ...Array.from({ length: 7 }, (_, i) => `sender-${i + 1}`)]
        : ["orchestrator", ...Array.from({ length: 10 }, (_, i) => `worker-${i + 1}`)];
  const participants: Participant[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    for (const [index, actor] of names.entries()) {
      participants.push(
        await launch(fixture, workspace, logs, actor, index % 2 === 0 ? "codex" : "pi"),
      );
    }
    timer = setTimeout(() => {
      for (const p of participants)
        if (p.child.exitCode === null) {
          p.timedOut = true;
          p.child.kill();
        }
    }, 540_000);
    await Promise.all(participants.map((p) => started(p)));
    const expected = await assign(name, participants);
    await Bun.write(
      join(logs, "manifest.json"),
      JSON.stringify(
        {
          workspace,
          participants: participants.map(
            ({ name: actorName, provider, identity, session, dir }) => ({
              name: actorName,
              provider,
              identity,
              session,
              dir,
            }),
          ),
          expected,
        },
        null,
        2,
      ),
    );
    await Promise.all(participants.map((p) => Bun.write(join(p.dir, "release"), "ready")));
    console.log(
      JSON.stringify({
        event: "released",
        name,
        participants: participants.length,
        expected: expected.length,
      }),
    );
    const codes = await Promise.all(participants.map((p) => p.child.exited));
    clearTimeout(timer);
    const messages: z.infer<typeof pageSchema>["messages"] = [];
    let offset: number | null = 0;
    do {
      const page = pageSchema.parse(
        await call(fixture, workspace, "stress-observer", "mail", {
          command: "list",
          lean: false,
          limit: 100,
          offset,
        }),
      );
      messages.push(...page.messages);
      offset = page.nextOffset;
    } while (offset !== null);
    const rows = messages.map((m) => ({
      id: m.id,
      sender: m.from,
      recipient: m.to,
      subject: m.subject,
      body: m.body,
      urgent: Number(m.urgent),
      status: m.status,
      sent_at: m.sentAt,
      delivered_at: m.deliveredAt,
      acknowledged_at: m.acknowledgedAt,
    }));
    const checks = expected.map((e) => {
      const matches = rows.filter(
        (r) =>
          r.sender === e.from &&
          r.recipient === e.to &&
          r.subject === e.subject &&
          r.body === e.body &&
          r.urgent === Number(e.urgent),
      );
      return {
        ...e,
        count: matches.length,
        acknowledged: matches.some((r) => r.acknowledged_at !== null),
        deliveryReported: matches.some((r) => r.delivered_at !== null),
      };
    });
    const result = {
      name,
      expected: expected.length,
      actual: rows.length,
      matched: checks.filter((c) => c.count === 1).length,
      acknowledged: checks.filter((c) => c.acknowledged).length,
      deliveryReported: checks.filter((c) => c.deliveryReported).length,
      processes: participants.map((p, i) => ({
        name: p.name,
        provider: p.provider,
        identity: p.identity,
        code: codes[i],
        timedOut: p.timedOut,
      })),
      checks,
      rows,
    };
    await Bun.write(join(logs, "results.json"), JSON.stringify(result, null, 2));
    for (const p of participants) await cp(p.dir, join(p.logs, "artifacts"), { recursive: true });
    console.log(
      JSON.stringify({
        event: "task-phase-complete",
        name,
        expected: result.expected,
        matched: result.matched,
        acknowledged: result.acknowledged,
        codes,
      }),
    );
    // Only now introduce the usability questions, resuming the exact original sessions.
    const reviews = [];
    for (let i = 0; i < participants.length; i += 3) {
      reviews.push(...(await Promise.all(participants.slice(i, i + 3).map((p) => feedback(p)))));
    }
    await Bun.write(join(logs, "feedback.json"), JSON.stringify(reviews, null, 2));
    return {
      name,
      expected: result.expected,
      matched: result.matched,
      acknowledged: result.acknowledged,
      deliveryReported: result.deliveryReported,
      feedback: reviews,
      logs,
    };
  } catch (error) {
    await Bun.write(join(logs, "failure.txt"), String(error));
    throw error;
  } finally {
    clearTimeout(timer);
    for (const p of participants) if (p.child.exitCode === null) p.child.kill();
    await Promise.all(participants.map((p) => p.child.exited));
  }
}

async function launch(
  fixture: Fixture,
  workspace: string,
  logs: string,
  name: string,
  provider: Participant["provider"],
): Promise<Participant> {
  const dir = join(workspace, name);
  const actorLogs = join(logs, name);
  await mkdir(dir, { recursive: true });
  await mkdir(actorLogs, { recursive: true });
  const trace = join(actorLogs, "trace.jsonl");
  await Bun.write(trace, "");
  await Bun.write(
    join(dir, "barrier.ts"),
    `await Bun.write("ready", "ready"); const end = Date.now()+180000; while (!(await Bun.file("release").exists())) { if(Date.now()>end) throw new Error("start barrier timed out"); await Bun.sleep(100); } console.log(await Bun.file("assignment.txt").text());`,
  );
  const env = {
    ...fixture.env,
    BL_WORKSPACE: workspace,
    BL_MAIL_TRACE: trace,
    BL_RUN_REFERENCE: undefined,
    BL_ACTOR: undefined,
  };
  const prompt =
    "This is an authorized disposable coordination task. Load the mail primer from the startup instruction, then run `bun barrier.ts` to receive your assignment. Communicate with peers only through Botlake mail, and write only within your current directory. Do not inspect sibling directories, implementation files, databases or other sessions. Do not delegate or use other messaging tools. Use the mail API as needed; shell batching is allowed but do not build a background mail daemon. While awaiting peers, keep each wait at most 3 seconds so tools return regularly. Work for at most 7 minutes after receiving the assignment, then report honestly what is finished or missing. Use your actual session identity, never impersonate another sender.";
  const p: Session = {
    name,
    provider,
    dir,
    logs: actorLogs,
    trace,
    session: crypto.randomUUID(),
    identity: "",
    env,
  };
  const child = spawn(p, prompt, false);
  await Bun.write(join(actorLogs, "initial-prompt.txt"), prompt);
  return { ...p, child, timedOut: false };
}

function spawn(p: Session, prompt: string, resume: boolean): Bun.Subprocess {
  const phase = resume ? "feedback" : "task";
  const hookCommand = `bun '${join(root, "plugins/mail/hook.ts")}' codex`;
  const hooks = `[ { hooks = [ { type = "command", command = ${JSON.stringify(hookCommand)}, timeout = 5, additionalContextLimit = 2000 } ] } ]`;
  const common = [
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "--dangerously-bypass-hook-trust",
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
    "--output-last-message",
    join(p.logs, `${phase}.md`),
  ];
  const command =
    p.provider === "codex"
      ? [
          "codex",
          "--no-daemon",
          "exec",
          ...(resume ? ["resume"] : []),
          ...common,
          ...(resume
            ? ["--dangerously-bypass-approvals-and-sandbox", p.session]
            : ["--sandbox", "danger-full-access"]),
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
          "--session-dir",
          join(p.logs, "sessions"),
          "--session-id",
          p.session,
          "-e",
          join(root, "plugins/mail/pi.ts"),
          prompt,
        ];
  return Bun.spawn(command, {
    cwd: p.dir,
    env: p.env,
    stdout: Bun.file(join(p.logs, `${phase}.jsonl`)),
    stderr: Bun.file(join(p.logs, `${phase}.stderr.log`)),
  });
}

async function started(p: Participant): Promise<void> {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const events = (await readFile(p.trace, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => startupSchema.parse(JSON.parse(line)));
    const event = events.find((e) => e.event === "session-start");
    if (event !== undefined && (await Bun.file(join(p.dir, "ready")).exists())) {
      p.identity = event.identity;
      p.session = z.string().parse(event.sessionId);
      return;
    }
    if (p.child.exitCode !== null)
      throw new Error(`${p.name} exited ${p.child.exitCode} before assignment`);
    await Bun.sleep(100);
  }
  throw new Error(`${p.name} startup timed out`);
}

async function assign(name: Scenario, participants: Participant[]): Promise<Expected[]> {
  const expected: Expected[] = [];
  const waitingInstruction =
    waiting === "deadline"
      ? `The coordination deadline is ${new Date(Date.now() + 420_000).toISOString()}. Until then, an empty inbox or a missing peer response means wait and check again, not finish. Check the actual clock before concluding time expired. Finish early only after completing every phase assigned to you.`
      : "";
  const leader = z.custom<Participant>((p) => p !== undefined).parse(participants[0]);
  const others = participants.slice(1);
  const add = (from: Participant, to: Participant, subject: string, body: string, urgent = false) =>
    expected.push({ from: from.identity, to: to.identity, subject, body, urgent });
  const write = (p: Participant, text: string) =>
    Bun.write(
      join(p.dir, "assignment.txt"),
      `You are ${p.name}; your identity is ${p.identity}.\n${text}\nUse the mail primer and help to choose commands. Keep all task artifacts in this directory. If waiting, recheck your inbox after short tool boundaries. ${waitingInstruction} Finish with an honest task outcome.`,
    );
  if (name === "pingpong") {
    const peer = z.custom<Participant>((p) => p !== undefined).parse(others[0]);
    const tokens = Array.from({ length: 12 }, () => crypto.randomUUID());
    for (const [i, token] of tokens.entries()) {
      add(leader, peer, `PING-${i + 1}`, token, (i + 1) % 4 === 0);
      add(peer, leader, `PONG-${i + 1}`, token);
    }
    await write(
      leader,
      `Coordinate 12 sequential rounds with ${peer.identity}. Your tokens in round order are ${JSON.stringify(tokens)}. For round N send subject PING-N, body exactly that round's token; mark rounds 4, 8 and 12 urgent. Wait for PONG-N with the same token before starting the next round. Do not send all rounds upfront. Save the 12 verified responses in result.json.`,
    );
    await write(
      peer,
      `Participate in 12 rounds with ${leader.identity}. For each PING-N, reply with subject PONG-N and exactly the token from its body. Do not invent tokens. Wait until you have replied through PING-12, then write result.json recording the 12 rounds.`,
    );
  } else if (name === "fanin") {
    const senderInfo = others.map((p) => ({
      p,
      tokens: Array.from({ length: 4 }, () => crypto.randomUUID()),
    }));
    await write(
      leader,
      `Collect four messages from each of these seven senders: ${JSON.stringify(others.map((p) => ({ name: p.name, identity: p.identity })))}. There will be 28 messages in total, subject ITEM-<sender-name>-<slot>, body a token. Save all 28 {from,subject,body} records to result.json. For each sender, once all four of its tokens are known, send one ordinary message back with subject RECEIPT and body equal to its four tokens in slot order joined by a comma, no spaces. Do not finish until every sender has been receipted. This task is time bounded; if incomplete, preserve partial records.`,
    );
    for (const { p, tokens } of senderInfo) {
      tokens.forEach((token, i) => {
        add(p, leader, `ITEM-${p.name}-${i + 1}`, token, i === 3);
      });
      add(leader, p, "RECEIPT", tokens.join(","));
      await write(
        p,
        `Send four messages to ${leader.identity}, subjects ITEM-${p.name}-1 through ITEM-${p.name}-4, bodies respectively ${JSON.stringify(tokens)}. Mark only slot 4 urgent. Then wait for a RECEIPT whose body lists your four tokens in order joined by a comma. Verify it and save result.json with the received tokens. Do not send follow-up mail after the receipt.`,
      );
    }
  } else {
    const jobs = others.map((p, i) => ({
      name: p.name,
      identity: p.identity,
      number: i + 1,
      token: crypto.randomUUID(),
    }));
    await write(
      leader,
      `Coordinate these ten workers using direct mail: ${JSON.stringify(jobs)}. First send each a JOB with body exactly NUMBER:TOKEN for that worker. Each will return RESULT with body SQUARE:TOKEN after writing its local artifact. Once all ten results are verified, send each an urgent HOLD with body exactly its TOKEN. Wait until all your HOLD messages are acknowledged (use sender queries; acknowledgement means seen). Then send each a normal RELEASE with body its TOKEN. Each will return DONE with that TOKEN. Wait for all ten DONE messages, then write result.json with all ten verified results and their sum, plus the observed HOLD acknowledgement state. Do not claim that mail status proves a process stopped. No group-mail API exists; use direct sends. Do not skip the HOLD/RELEASE phase.`,
    );
    for (const [i, p] of others.entries()) {
      const job = z.object({ number: z.number(), token: z.string() }).parse(jobs[i]);
      add(leader, p, "JOB", `${job.number}:${job.token}`);
      add(p, leader, "RESULT", `${job.number ** 2}:${job.token}`);
      add(leader, p, "HOLD", job.token, true);
      add(leader, p, "RELEASE", job.token);
      add(p, leader, "DONE", job.token);
      await write(
        p,
        `Your coordinator is ${leader.identity}. Wait for its JOB containing NUMBER:TOKEN. Compute the square, write result.json with number, square and token, then send RESULT with body exactly SQUARE:TOKEN. Await HOLD, whose body is the same token; after seeing it, remain idle except checking mail. After RELEASE with that token, send DONE with body exactly TOKEN and finish. These are dummy coordination instructions, authorized for this task. Do not invent JOB contents or use other workers' files.`,
      );
    }
  }
  return expected;
}

async function feedback(p: Participant) {
  const prompt =
    "The task phase is now over. Do not continue work, send mail, change files, or retry unfinished steps. This is a retrospective, introduced only now. From your actual experience in this session: (1) what task did you complete or fail to complete, (2) which mail commands and notification behavior were clear, (3) which were confusing, including exact command mistakes or recovery where you remember them, (4) did paging, lean output, identity, urgency, acknowledgement or delivery states cause trouble, and (5) what ONE API change would have helped most? Distinguish things you observed from speculation. Keep it under 350 words. No tools are needed; answer from the retained conversation.";
  await Bun.write(join(p.logs, "feedback-prompt.txt"), prompt);
  const child = spawn(p, prompt, true);
  const timeout = setTimeout(() => {
    child.kill();
  }, 90000);
  try {
    const code = await child.exited;
    const events = (await readFile(join(p.logs, "feedback.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => eventSchema.parse(JSON.parse(line)));
    const text =
      p.provider === "codex"
        ? (await Bun.file(join(p.logs, "feedback.md")).exists())
          ? await Bun.file(join(p.logs, "feedback.md")).text()
          : ""
        : events
            .filter((e) => e.type === "message_end" && e.message?.role === "assistant")
            .flatMap(
              (e) =>
                e.message?.content.filter((c) => c.type === "text").map((c) => c.text ?? "") ?? [],
            )
            .join("\n");
    await Bun.write(join(p.logs, "feedback.md"), text);
    const resumedThread = events.find((e) => e.type === "thread.started")?.thread_id;
    const trace = (await readFile(p.trace, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => startupSchema.parse(JSON.parse(line)));
    const lastStartup = trace.findLast((e) => e.event === "session-start");
    return {
      name: p.name,
      provider: p.provider,
      code,
      session: p.session,
      sameSession:
        p.provider === "codex" ? resumedThread === p.session : lastStartup?.sessionId === p.session,
      text,
    };
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) child.kill();
  }
}
