// Diagnostic only: use a copy of a seeded disposable database, after the wire benchmarks.
// bun --cpu-prof --cpu-prof-dir /tmp/profile scripts/profiling/ts-hotpaths.ts DB QUERIES_JSON
import { compileQuery, predicateSchema, Runtime } from "@botlake/core";
import batteriesExtension from "@botlake/extension-batteries";
import { z } from "zod";

const [database, queriesPath] = z.tuple([z.string(), z.string()]).parse(Bun.argv.slice(2));
const queries = z
  .record(z.string(), z.tuple([z.string(), z.json()]))
  .parse(await Bun.file(queriesPath).json());
const runtime = new Runtime({ database });
const records: unknown[] = [];
async function measure(name: string, run: () => unknown): Promise<void> {
  const warmup = performance.now() + 500;
  while (performance.now() < warmup) await run();
  const samples: number[] = [];
  const until = performance.now() + 2000;
  while (performance.now() < until) {
    const start = performance.now();
    await run();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  records.push({ name, n: samples.length, medianMs: samples[Math.floor(samples.length / 2)] });
}
try {
  await runtime.start([batteriesExtension]);
  records.push({
    sqlite: runtime.graph.db.query("SELECT sqlite_version() AS version").get(),
    journal: runtime.graph.db.query("PRAGMA journal_mode").get(),
    synchronous: runtime.graph.db.query("PRAGMA synchronous").get(),
    cache: runtime.graph.db.query("PRAGMA cache_size").get(),
    mmap: runtime.graph.db.query("PRAGMA mmap_size").get(),
  });
  for (const [name, [op, input]] of Object.entries(queries)) {
    if (op !== "list") continue;
    const query = z.object({ where: predicateSchema, limit: z.number() }).parse(input);
    const compiled = compileQuery(query.where);
    const sql = `SELECT s.id FROM nodes s WHERE ${compiled.sql} ORDER BY s.created_at,s.id LIMIT ?`;
    const statement = runtime.graph.db.query(sql);
    const rows = runtime.graph.list(query);
    records.push({
      name,
      rows: rows.length,
      sql,
      bindings: compiled.bindings,
      plan: runtime.graph.db
        .query(`EXPLAIN QUERY PLAN ${sql}`)
        .all(...compiled.bindings, query.limit),
    });
    await measure(`${name}:prepared-id-query`, () =>
      statement.all(...compiled.bindings, query.limit),
    );
    await measure(`${name}:graph-list`, () => runtime.graph.list(query));
    await measure(`${name}:runtime-invoke`, () => runtime.invoke(op, input));
    await measure(`${name}:json-stringify-result`, () => JSON.stringify(rows));
  }
  process.stdout.write(`${JSON.stringify(records, null, 2)}\n`);
} finally {
  await runtime.stop();
}
