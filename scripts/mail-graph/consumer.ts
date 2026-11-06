import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { z } from "zod";

import { system } from "../../tests/blackbox/fixtures/system.ts";
import { call, mailLake, root } from "./fixture.ts";

const output = join(root, "out/mail-graph/consumer");
const uiRoot = resolve(z.string().min(1, "Pass the Botlake UI checkout path").parse(Bun.argv[2]));
await mkdir(output, { recursive: true });
for (const name of ["stop", "fixture.json", "cleanup.json"])
  await rm(join(output, name), { force: true });
await Bun.write(join(output, "server.log"), "");
await Bun.write(join(output, "server.stderr.log"), "");
const fixture = await system();
let server: Bun.Subprocess | undefined;
try {
  const workspace = await mailLake(fixture, "mail-ui");
  const manifestPath = join(workspace, ".botlake/package.json");
  const manifest = z
    .object({ botlake: z.object({ name: z.string(), extensions: z.array(z.string()) }) })
    .parse(await Bun.file(manifestPath).json());
  manifest.botlake.extensions.push(
    "@botlake/extension-flags",
    "@botlake/extension-agents",
    "@botlake/extension-work",
  );
  await Bun.write(manifestPath, JSON.stringify({ private: true, type: "module", ...manifest }));
  await fixture.botlake(["lake", "restart", "--workspace", workspace]);
  const identitySchema = z.object({ identity: z.string(), nodeId: z.string() });
  const alice = identitySchema.parse(
    await call(fixture, workspace, "seed", "identity", {
      command: "startup",
      provider: "codex",
      nativeSessionId: "ui-alice",
    }),
  );
  const bob = identitySchema.parse(
    await call(fixture, workspace, "seed", "identity", {
      command: "startup",
      provider: "pi",
      nativeSessionId: "ui-bob",
    }),
  );
  const task = await call(fixture, workspace, "seed", "work", {
    command: "create",
    title: "Inspect mail consumer",
    description: "Disposable UI consumer test",
    assignee: bob.identity,
  });
  const ids: string[] = [];
  for (let i = 0; i < 25; i++) {
    const message = z.object({ id: z.string() }).parse(
      await call(fixture, workspace, alice.identity, "mail", {
        command: "send",
        to: bob.identity,
        subject: `Consumer message ${String(i + 1).padStart(2, "0")}`,
        body: `Consumer body ${i + 1}.\n` + "Long readable mail contents. ".repeat(80),
        urgent: i === 0,
      }),
    );
    ids.push(message.id);
    if (i < 3)
      await call(fixture, workspace, bob.identity, "mail", {
        command: "delivered",
        ids: [message.id],
      });
    if (i === 0)
      await call(fixture, workspace, bob.identity, "mail", { command: "ack", id: message.id });
  }
  const parent = z.string().parse(ids[0]);
  const reply = await call(fixture, workspace, bob.identity, "mail", {
    command: "reply",
    id: parent,
    body: "Consumer reply body.",
  });
  const env = {
    ...fixture.env,
    BOTLAKE_WORKSPACE: workspace,
    BOTLAKE_UI_HOST: "127.0.0.1",
    BOTLAKE_UI_PERSON: "mail-ui-observer",
    BOTLAKE_UI_PUSH_FILE: join(fixture.dir, "ui-push.json"),
    BOTLAKE_UI_SOCKET: join(fixture.dir, "ui.sock"),
    BOTLAKE_UI_PERF_LOG: join(output, "perf.log"),
  };
  server = Bun.spawn(
    ["node", "--experimental-transform-types", "server/index.ts", "--port", "18184"],
    {
      cwd: uiRoot,
      env,
      stdout: Bun.file(join(output, "server.log")),
      stderr: Bun.file(join(output, "server.stderr.log")),
    },
  );
  const until = Date.now() + 20000;
  while (!(await Bun.file(join(output, "server.log")).text()).includes("Control:")) {
    if (server.exitCode !== null || Date.now() > until)
      throw new Error("UI server failed to start; inspect server logs");
    await Bun.sleep(100);
  }
  const base = "http://127.0.0.1:18184";
  const workspaces = z
    .array(z.object({ id: z.string(), path: z.string() }))
    .parse(await (await fetch(`${base}/api/workspaces`)).json());
  const source = z
    .string()
    .parse(
      workspaces.find((entry) => entry.path === workspace || entry.path === `/private${workspace}`)
        ?.id,
    );
  const metadata = {
    workspace,
    source,
    alice,
    bob,
    parent,
    reply,
    task,
    base,
    url: `${base}/?source=${source}&agent=${bob.nodeId}`,
    blBin: fixture.blBin,
    botlakeHome: fixture.home,
  };
  await Bun.write(join(output, "fixture.json"), JSON.stringify(metadata, null, 2));
  console.log(JSON.stringify(metadata));
  const results: unknown[] = [];
  for (const direction of ["received", "sent"]) {
    const timings: number[] = [];
    let bytes = 0;
    for (let i = 0; i < 30; i++) {
      const started = performance.now();
      const response = await fetch(
        `${base}/api/mail?workspace=${source}&identity=${bob.identity}&direction=${direction}`,
      );
      if (!response.ok) throw new Error(await response.text());
      const body = await response.text();
      bytes = Buffer.byteLength(body);
      timings.push(performance.now() - started);
    }
    const sorted = timings.toSorted((a, b) => a - b);
    results.push({
      direction,
      samples: sorted.length,
      p50Ms: sorted[14],
      p95Ms: sorted[28],
      maxMs: sorted.at(-1),
      bytes,
    });
  }
  await Bun.write(join(output, "api-timings.json"), JSON.stringify(results, null, 2));
  const deadline = Date.now() + 600000;
  while (!(await Bun.file(join(output, "stop")).exists()) && Date.now() < deadline)
    await Bun.sleep(250);
} finally {
  if (server !== undefined) {
    server.kill();
    await server.exited;
  }
  await fixture.close();
  await Bun.write(join(output, "cleanup.json"), JSON.stringify({ removed: fixture.dir }));
}
