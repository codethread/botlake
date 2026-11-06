import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { sessionIdentity } from "@botlake/native-session";
import { z } from "zod";

import { system } from "../../tests/blackbox/fixtures/system.ts";
import { call, mailLake, root } from "./fixture.ts";

const message = z.object({
  id: z.string(),
  from: z.string(),
  to: z.string(),
  status: z.string(),
  repliesTo: z.string().nullable(),
  deliveredAt: z.number().nullable(),
  acknowledgedAt: z.number().nullable(),
});
const page = z.object({ messages: z.array(message), nextOffset: z.number().nullable() });
const startup = z.object({ identity: z.string(), nodeId: z.string() });
const waiting = z.object({ reason: z.enum(["satisfied", "timeout"]), count: z.number() });
const output = join(root, "out/mail-graph/smoke");
await mkdir(output, { recursive: true });
const fixture = await system();
try {
  const workspace = await mailLake(fixture, "graph-smoke");
  const alice = startup.parse(
    await call(fixture, workspace, "seed", "identity", {
      command: "startup",
      provider: "codex",
      nativeSessionId: "alice",
    }),
  );
  const bobId = sessionIdentity({ provider: "pi", nativeSessionId: "bob" });
  const invoke = (by: string, input: unknown) => call(fixture, workspace, by, "mail", input);
  const observe = (
    query: string,
    params: Record<string, string>,
    minCount: number,
    timeoutSecs = 0,
  ) => call(fixture, workspace, "observer", "await", { query, params, minCount, timeoutSecs });
  assert.equal(
    waiting.parse(await observe("mail-pending", { recipient: bobId }, 1)).reason,
    "timeout",
  );
  const inFlight = observe("mail-pending", { recipient: bobId }, 1, 4);
  await Bun.sleep(150);
  const sent = message.parse(
    await invoke(alice.identity, {
      command: "send",
      to: bobId,
      subject: "Wait wakeup",
      body: "body",
      urgent: true,
    }),
  );
  assert.equal(waiting.parse(await inFlight).reason, "satisfied");
  assert.equal(message.parse(await invoke(bobId, { command: "read", id: sent.id })).status, "sent");
  const bob = startup.parse(
    await call(fixture, workspace, "seed", "identity", {
      command: "startup",
      provider: "pi",
      nativeSessionId: "bob",
    }),
  );
  assert.equal(
    waiting.parse(await observe("mail-received-by-node", { identityNode: bob.nodeId }, 1, 3))
      .reason,
    "satisfied",
  );
  assert.equal(
    waiting.parse(await observe("mail-sent-by-node", { identityNode: alice.nodeId }, 1)).reason,
    "satisfied",
  );
  for (const request of [
    { command: "add", from: sent.id, to: alice.nodeId, relation: "mail/sent-to" },
    { command: "remove", from: sent.id, to: bob.nodeId, relation: "mail/sent-to" },
    { command: "add", from: sent.id, to: alice.nodeId, relation: "mail/replies-to" },
  ]) {
    const error = await fixture.cli(
      [
        "--workspace",
        workspace,
        "--identity",
        alice.identity,
        "--input",
        JSON.stringify(request),
        "edge",
      ],
      false,
    );
    assert.match(String(error), /require/u);
  }
  const ackWait = observe("mail-acknowledged", { id: sent.id }, 1, 4);
  await Bun.sleep(150);
  await invoke(bobId, { command: "ack", id: sent.id });
  assert.equal(waiting.parse(await ackWait).reason, "satisfied");
  const directAck = message.parse(await invoke(bobId, { command: "read", id: sent.id }));
  assert.equal(directAck.deliveredAt, null);
  await invoke(bobId, { command: "delivered", ids: [sent.id] });
  await invoke(bobId, { command: "ack", id: sent.id });
  const after = message.parse(await invoke(bobId, { command: "read", id: sent.id }));
  assert.equal(after.acknowledgedAt, directAck.acknowledgedAt);
  assert.equal(typeof after.deliveredAt, "number");
  const reply = message.parse(
    await invoke(bobId, { command: "reply", id: sent.id, body: "reply body" }),
  );
  assert.equal(reply.to, alice.identity);
  assert.equal(reply.repliesTo, sent.id);
  assert.equal(
    waiting.parse(await observe("mail-replies", { id: sent.id }, 1)).reason,
    "satisfied",
  );
  const context = z
    .object({ id: z.string() })
    .parse(
      await call(fixture, workspace, "seed", "node", { command: "add", title: "Run context" }),
    );
  const contextual = message.parse(
    await invoke(alice.identity, {
      command: "send",
      to: bobId,
      subject: "Context",
      body: "context body",
      about: context.id,
    }),
  );
  assert.equal(
    waiting.parse(await observe("mail-about", { id: context.id }, 1)).reason,
    "satisfied",
  );
  const bad = await fixture.cli(
    [
      "--workspace",
      workspace,
      "--identity",
      bobId,
      "--input",
      JSON.stringify({ command: "delivered", ids: [contextual.id, reply.id] }),
      "mail",
    ],
    false,
  );
  assert.match(String(bad), /mailbox/u);
  assert.equal(
    message.parse(await invoke(bobId, { command: "read", id: contextual.id })).status,
    "sent",
  );
  for (let i = 0; i < 25; i++)
    await invoke(alice.identity, {
      command: "send",
      to: bobId,
      subject: "Page",
      body: "long-content-".repeat(250),
    });
  const raw = await invoke(alice.identity, {
    command: "list",
    from: alice.identity,
    subject: "Page",
  });
  assert.equal(JSON.stringify(raw).includes("long-content"), false);
  const first = page.parse(raw);
  assert.equal(first.messages.length, 20);
  assert.equal(first.nextOffset, 20);
  const second = page.parse(
    await invoke(alice.identity, {
      command: "list",
      from: alice.identity,
      subject: "Page",
      offset: 20,
      lean: false,
    }),
  );
  assert.equal(second.messages.length, 5);
  assert.equal(second.nextOffset, null);
  assert.equal(new Set([...first.messages, ...second.messages].map((m) => m.id)).size, 25);
  await fixture.botlake(["lake", "restart", "--workspace", workspace]);
  assert.equal(
    waiting.parse(await observe("mail-received-by-node", { identityNode: bob.nodeId }, 27)).reason,
    "satisfied",
  );
  const db = new Database(join(workspace, ".botlake/world.db"), { readonly: true });
  assert.equal(
    db.query("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'mail%'").all()
      .length,
    0,
  );
  const edges = db
    .query(
      "SELECT relation, count(*) AS count FROM edges WHERE relation LIKE 'mail/%' GROUP BY relation",
    )
    .all();
  db.close();
  const result = {
    passed: true,
    edges,
    checks: [
      "await arrival and timeout",
      "await acknowledgement",
      "late identity registration and restart links",
      "derived edge ownership",
      "reply and context queries",
      "lean offset paging",
      "atomic recipient receipts",
      "truthful idempotent lifecycle",
      "no mail tables",
    ],
  };
  await Bun.write(join(output, "results.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await fixture.close();
}
