import { cpus, platform, arch } from "node:os";
import { join, resolve } from "node:path";

import { requireValue, sql } from "@botlake/core";
import { z } from "zod";

import { system } from "../tests/blackbox/fixtures/system.ts";

const count = z.compile(z.coerce.number().int().min(4).max(128)).parse(Bun.argv[2] ?? 24);
const output = resolve(Bun.argv[3] ?? "docs/engdocs/standalone-benchmark.json");
const lakeStatusSchema = z.compile(z.object({ pid: z.number().int().positive() }));
const numberSchema = z.compile(z.number());
const responseSchema = z.compile(z.object({ ok: z.literal(true), result: z.unknown() }));
const host = await system();

try {
  const startup: number[] = [];
  const workspaces: string[] = [];
  const extension = `
    import { defineOp } from "@botlake/core";
    import { z } from "zod";

    const emptyInput = z.compile(z.object({}));
    const elapsed = z.compile(z.number());

    export default {
      name: "benchmark",
      activate(ctx) {
        ctx.graph.db.run(${JSON.stringify(sql`
          CREATE TABLE IF NOT EXISTS benchmark (
            id INTEGER PRIMARY KEY,
            value INTEGER NOT NULL
          );
          INSERT OR IGNORE INTO benchmark VALUES (1, 0);
        `)});
        ctx.register(defineOp({
          name: "load",
          input: emptyInput,
          output: elapsed,
          cli: { description: "load" },
          handler() {
            const start = performance.now();
            const update = ctx.graph.db.query(${JSON.stringify(sql`
              UPDATE benchmark
              SET value = value + 1
              WHERE id = 1
            `)});
            ctx.graph.db.transaction(() => {
              for (let index = 0; index < 100000; index++) update.run();
            }).immediate();
            return performance.now() - start;
          },
        }));
        ctx.register(defineOp({
          name: "lag",
          input: emptyInput,
          output: elapsed,
          cli: { description: "event loop delay" },
          async handler() {
            const start = performance.now();
            await new Promise(resolve => setTimeout(resolve, 0));
            return performance.now() - start;
          },
        }));
      },
    };
  `;
  for (let index = 0; index < count; index++) {
    const workspace = await host.workspace(`w${index}`, [
      "@botlake/extension-batteries",
      "./benchmark.ts",
    ]);
    await Bun.write(join(workspace, "benchmark.ts"), extension);
    workspaces.push(workspace);
  }
  const began = performance.now();
  for (const workspace of workspaces) {
    const start = performance.now();
    await host.botlake(["lake", "start", "--workspace", workspace]);
    startup.push(performance.now() - start);
  }

  const totalStartupMs = performance.now() - began;
  const pids = await Promise.all(
    workspaces.map(
      async (workspace) =>
        lakeStatusSchema.parse(await host.botlake(["lake", "status", "--workspace", workspace]))
          .pid,
    ),
  );
  const memberRssMiB = await Promise.all(pids.map((pid) => residentSetMiB(pid)));
  const loadMs: number[] = [];
  async function loadDatabase(): Promise<void> {
    for (let index = 0; index < 20; index++)
      loadMs.push(numberSchema.parse(await invoke("w0", "load")));
  }
  const latency: number[] = [];
  const delay: number[] = [];
  const siblings = workspaces.filter((_, index) => index !== 0 && index !== 2);

  async function probeSiblings(): Promise<void> {
    for (let index = 0; index < 100; index++) {
      const workspace = requireValue(siblings[index % siblings.length], "No sibling workspace");
      const start = performance.now();
      delay.push(numberSchema.parse(await invoke(workspace, "lag")));
      latency.push(performance.now() - start);
    }
  }
  const restartStarted = performance.now();

  async function restartMember(): Promise<number> {
    await host.botlake(["lake", "restart", "--workspace", "w2"]);
    return performance.now() - restartStarted;
  }
  const [, , restartMs] = await Promise.all([loadDatabase(), probeSiblings(), restartMember()]);
  const report = {
    date: new Date().toISOString().slice(0, 10),
    topology: "one Bun process per workspace",
    bun: Bun.version,
    platform: platform(),
    arch: arch(),
    cpu: cpus()[0]?.model ?? "unknown",
    workspaces: count,
    totalMemberRssMiB: memberRssMiB.reduce((sum, rss) => sum + rss, 0),
    memberRssMiB: distribution(memberRssMiB),
    totalStartupMs,
    memberStartupMs: distribution(startup),
    siblingLatencyMsUnderLoad: distribution(latency),
    siblingEventLoopDelayMsUnderLoad: distribution(delay),
    databaseLoadMs: distribution(loadMs),
    memberRestartMsUnderLoad: restartMs,
    measurement:
      "One Bun process per workspace; 20 transactions of 100,000 SQLite updates in w0 concurrent with 100 unaffected sibling probes and a w2 restart. Latency includes local Botlake routing; event loop delay uses a zero-delay timer. RSS is the sum of resident sets reported by ps for the standalone lake processes.",
  };

  await Bun.write(output, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await host.close();
}

// -- Private helpers --

async function invoke(workspace: string, name: string): Promise<unknown> {
  const wire = await host.wire({
    protocol_version: 1,
    request_id: crypto.randomUUID(),
    operation: "invoke",
    workspace,
    payload: { name, input: {} },
  });
  return responseSchema.parse(JSON.parse(wire)).result;
}

async function residentSetMiB(pid: number): Promise<number> {
  const child = Bun.spawn(["ps", "-o", "rss=", "-p", String(pid)], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`ps failed for ${pid}: ${stderr.trim()}`);
  return numberSchema.parse(Number(stdout.trim())) / 1024;
}

function distribution(samples: number[]): {
  median: number;
  p95: number;
  p99: number;
  max: number;
} {
  const sorted = samples.toSorted((left, right) => left - right);
  const at = (percentile: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * percentile))] ?? 0;
  return { median: at(0.5), p95: at(0.95), p99: at(0.99), max: at(1) };
}
