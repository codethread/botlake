import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { system } from "../../tests/blackbox/fixtures/system.ts";
import { call, mailLake, root } from "./fixture.ts";

const output = join(root, "out/mail-graph/benchmark");
await mkdir(output, { recursive: true });
const fixture = await system();
const results: unknown[] = [];
try {
  for (const mode of ["graph", "linked"] as const) await benchmark(mode);
} finally {
  await fixture.close();
}

async function benchmark(mode: "graph" | "linked") {
  const workspace = await mailLake(fixture, `bench-${mode}`, mode);
  const identities: string[] = [];
  for (let i = 0; i < 20; i++) {
    const record = z.object({ identity: z.string() }).parse(
      await call(fixture, workspace, "seed", "identity", {
        command: "startup",
        provider: "codex",
        nativeSessionId: `bench-${i}`,
      }),
    );
    identities.push(record.identity);
  }
  const sender = z.string().parse(identities[0]);
  const recipient = z.string().parse(identities[1]);
  let seeded = 0;
  let firstId = "";
  for (const size of [20, 200, 2000]) {
    const sends: number[] = [];
    while (seeded < size) {
      const started = performance.now();
      const record = z.object({ id: z.string() }).parse(
        await call(fixture, workspace, sender, "mail", {
          command: "send",
          to: identities[seeded % identities.length],
          subject: `Message ${seeded}`,
          body: "Payload ".repeat(128),
          urgent: seeded % 7 === 0,
        }),
      );
      sends.push(performance.now() - started);
      if (seeded === 1) firstId = record.id;
      seeded++;
    }
    const cases = [
      { name: "received-lean", op: "mail", input: { command: "list", to: recipient, limit: 20 } },
      { name: "sent-lean", op: "mail", input: { command: "list", from: sender, limit: 20 } },
      {
        name: "received-expanded",
        op: "mail",
        input: { command: "list", to: recipient, limit: 20, lean: false },
      },
      { name: "read", op: "mail", input: { command: "read", id: firstId } },
      {
        name: "await-probe",
        op: "await",
        input: { query: "mail-pending", params: { recipient }, minCount: 1, timeoutSecs: 0 },
      },
    ];
    const timings: unknown[] = [];
    for (const test of cases) {
      await call(fixture, workspace, sender, test.op, test.input);
      const values: number[] = [];
      let bytes = 0;
      for (let i = 0; i < 30; i++) {
        const start = performance.now();
        const result = await call(fixture, workspace, sender, test.op, test.input);
        values.push(performance.now() - start);
        bytes = Buffer.byteLength(JSON.stringify(result));
      }
      timings.push({ name: test.name, ...distribution(values), bytes });
    }
    const db = new Database(join(workspace, ".botlake/world.db"), { readonly: true });
    const pageCount = z
      .object({ page_count: z.number() })
      .parse(db.query("PRAGMA page_count").get()).page_count;
    const pageSize = z
      .object({ page_size: z.number() })
      .parse(db.query("PRAGMA page_size").get()).page_size;
    db.close();
    const result = {
      mode,
      size,
      sends: distribution(sends),
      timings,
      logicalDatabaseBytes: pageCount * pageSize,
    };
    results.push(result);
    await Bun.write(join(output, "results.json"), JSON.stringify(results, null, 2));
    console.log(JSON.stringify(result));
  }
}

function distribution(values: number[]) {
  const sorted = values.toSorted((a, b) => a - b);
  return {
    samples: sorted.length,
    p50Ms: sorted[Math.floor((sorted.length - 1) * 0.5)],
    p95Ms: sorted[Math.floor((sorted.length - 1) * 0.95)],
    maxMs: sorted.at(-1),
  };
}
