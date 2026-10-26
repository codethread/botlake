#!/usr/bin/env python3
"""Render report body and standalone figures from completed benchmark records.

Requires matplotlib; use the Codex bundled Python runtime when available.
Usage: report.py MAIN_JSON FOLLOWUP_JSON OUTPUT_DIRECTORY
Pipe the resulting report-body.html through the rich-response render.sh.
"""
import base64
import csv
import collections
import html
import json
from pathlib import Path
import statistics
import sys

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np


main = json.loads(Path(sys.argv[1]).read_text())
extra = json.loads(Path(sys.argv[2]).read_text())
out = Path(sys.argv[3])
out.mkdir(parents=True, exist_ok=True)
names = {"show": "Point read", "update": "Attribute update", "add": "Create strand",
         "list500": "Select + return 500", "selective": "Owner + state filter",
         "complex": "Compound attributes", "edge": "Edge + endpoint filter"}
colors = {"ts": "#286983", "jvm": "#b4637a"}
memory = main["memory"] + extra["memory"]


def selected(flavor, size, name, clients, transport="mill-socket"):
    records = [m for w in main["workloads"] if w["flavor"] == flavor and w["strands"] == size
               for m in w["measurements"] if m["name"] == name and m["concurrency"] == clients
               and m["transport"] == transport]
    if len(records) != main["options"]["repeats"]:
        raise ValueError(f"Incomplete measurements: {flavor} {size} {name} {clients} {transport}")
    return records


def metric(flavor, size, name, clients, key, transport="mill-socket"):
    values = selected(flavor, size, name, clients, transport)
    if key in ("median", "p95", "p99"):
        return statistics.median(v["latencyMs"][key] for v in values)
    if key == "cores":
        return statistics.median(v["runtimeCpuSeconds"] / v["seconds"] for v in values)
    return statistics.median(v[key] for v in values)


def mem(flavor, count):
    return [r["idle"]["runtimeRssMiB"]["median"] for r in memory
            if r["flavor"] == flavor and r["weavers"] == count and r["pooled"]]


def table(headers, rows):
    return "<table><thead><tr>" + "".join(f"<th>{h}</th>" for h in headers) + "</tr></thead><tbody>" + "".join(
        "<tr>" + "".join(f"<td>{v}</td>" for v in row) + "</tr>" for row in rows) + "</tbody></table>"


def image(path, alt):
    return f'<img style="width:100%;height:auto" alt="{html.escape(alt)}" src="data:image/svg+xml;base64,{base64.b64encode(path.read_bytes()).decode()}">'


plt.rcParams.update({"font.size": 11, "figure.facecolor": "#fffaf3", "axes.facecolor": "#fffaf3",
                     "axes.spines.top": False, "axes.spines.right": False, "svg.fonttype": "none"})
fig, ax = plt.subplots(figsize=(9, 4.3), layout="constrained")
x = np.arange(3)
for i, flavor in enumerate(("ts", "jvm")):
    sets = [mem(flavor, count) for count in (1, 4, 8)]
    mids = [statistics.median(v) for v in sets]
    errors = np.array([[m - min(v) for m, v in zip(mids, sets)], [max(v) - m for m, v in zip(mids, sets)]])
    bars = ax.bar(x + (i - .5) * .35, mids, .35, yerr=errors, capsize=4, color=colors[flavor], label="TS / Bun" if flavor == "ts" else "Canonical / JVM")
    ax.bar_label(bars, labels=[f"{v:.0f}" for v in mids], padding=9)
ax.set_xticks(x, ["1 weaver", "4 weavers", "8 weavers"])
ax.set_ylabel("Runtime process RSS (MiB)")
ax.set_title("Idle pooled weavers · median and range across three fresh boots")
ax.legend(loc="upper left")
ax.set_ylim(0, max(max(mem("jvm", c)) for c in (1, 4, 8)) * 1.3)
fig.savefig(out / "idle-memory.svg")
plt.close(fig)

fig, axes = plt.subplots(1, 2, figsize=(13, 5.8), layout="constrained", sharey=True)
order = ["show", "update", "add", "list500", "selective", "complex", "edge"]
y = np.arange(len(order))
for ax, clients in zip(axes, (1, 8)):
    for i, flavor in enumerate(("ts", "jvm")):
        values = [metric(flavor, 50000, name, clients, "opsPerSecond") for name in order]
        ax.barh(y + (i - .5) * .35, values, .35, color=colors[flavor], label="TS / Bun" if flavor == "ts" else "Canonical / JVM")
    ax.set_xscale("log")
    ax.set_xlabel("Completed operations / second (log scale)")
    ax.set_title(f"{clients} concurrent client{'s' if clients > 1 else ''}")
    ax.grid(axis="x", alpha=.2)
    ax.set_axisbelow(True)
axes[0].set_yticks(y, [names[k] for k in order])
axes[0].invert_yaxis()
axes[1].legend(loc="lower right")
fig.suptitle("50,000 strands · real operations through Mill · median of three runs")
fig.savefig(out / "throughput.svg")
plt.close(fig)

body = [f'<p><small>{main["date"]} · {html.escape(main["cpu"])} · 10 CPU cores · 16 GiB RAM · Bun {main["bun"]} · Java 21</small></p>']
body += ['<p><strong>TS uses substantially less memory and wins small socket operations. Canonical Millstrand handles concurrent, result-heavy queries much better within one weaver.</strong> Both can pool multiple weavers; canonical pooling is opt-in, while TS always pools. The primary comparison uses pooled Batteries-only weavers, native runtime defaults, fresh databases and the same logical fixture. Launching the CLI narrows the small-operation difference substantially.</p>']
body += ["<h2>Idle memory</h2>", image(out / "idle-memory.svg", "Idle runtime RSS across one, four and eight pooled weavers")]
rows = []
for count in (1, 4, 8):
    row = [str(count)]
    for flavor in ("ts", "jvm"):
        values = mem(flavor, count)
        row.append(f"{statistics.median(values):.1f} MiB <small>({min(values):.1f}–{max(values):.1f})</small>")
    row.append(f"{statistics.median(mem('jvm', count)) / statistics.median(mem('ts', count)):.1f}×")
    rows.append(row)
body += [table(["Pooled weavers", "TS: median (boot range)", "JVM: median (boot range)", "JVM / TS"], rows)]
isolated = next(r for r in memory if not r["pooled"])
body += [f'<p>Four separate canonical JVMs used <strong>{isolated["idle"]["runtimeRssMiB"]["median"]:.0f} MiB total</strong>, averaging {isolated["idle"]["runtimeRssMiB"]["median"] / 4:.0f} MiB per process in one supplementary boot. This represents the default isolated deployment; the pooled one-weaver figure above includes the JVM pool host overhead.</p>']
body += ['<p><small>RSS is sampled with macOS <code>ps</code>, 10 seconds after readiness and five times at one-second intervals. Values include all workers/threads in the runtime process and exclude the small Go Mill supervisor and load clients. RSS is not retained heap or unique physical footprint; summing isolated JVMs can count shared pages more than once. No forced GC or heap tuning. Three fresh boots per pooled size; error bars show the boot range. JVM GC/startup allocation makes the marginal per-member slope too noisy to infer from these few points.</small></p>']
rows = []
for n in (10000, 50000):
    row = [f"{n:,}"]
    for flavor in ("ts", "jvm"):
        values = [w["seededIdle"]["runtimeRssMiB"]["median"] for w in main["workloads"] if w["flavor"] == flavor and w["strands"] == n]
        row.append(f"{statistics.median(values):.1f} MiB ({min(values):.1f}–{max(values):.1f})")
    rows.append(row)
body += ['<h3>One weaver after loading and warming the fixed dataset</h3>', table(["Strands", "TS RSS", "JVM RSS"], rows), '<p><small>Measured after a 15-second read warmup and a further 10-second idle period, before writes grow either fixture.</small></p>']
body += ['<h2>Operations under load</h2>', image(out / "throughput.svg", "Throughput at 50,000 strands with one and eight concurrent clients")]
body += ['<div class="tabs"><label class="tab"><input type="radio" name="size" checked>50,000 strands</label><label class="tab"><input type="radio" name="size">10,000 strands</label>']
csv_rows = []
for n in (50000, 10000):
    rows = []
    for name in order:
        ts1 = metric("ts", n, name, 1, "median")
        j1 = metric("jvm", n, name, 1, "median")
        ts8 = metric("ts", n, name, 8, "opsPerSecond")
        j8 = metric("jvm", n, name, 8, "opsPerSecond")
        rows.append([names[name], f"{ts1:.2f} / {j1:.2f}", f"{ts8:,.1f} / {j8:,.1f}",
                     f"{metric('ts', n, name, 8, 'p95'):.2f} / {metric('jvm', n, name, 8, 'p95'):.2f}"])
        for flavor in ("ts", "jvm"):
            for clients in (1, 8):
                csv_rows.append([n, flavor, name, clients,
                    metric(flavor, n, name, clients, "opsPerSecond"), metric(flavor, n, name, clients, "median"),
                    metric(flavor, n, name, clients, "p95"), metric(flavor, n, name, clients, "cores")])
    body += ['<div class="tab-panel">', table(["Operation", "1 client p50 ms<br>TS / JVM", "8 clients ops/s<br>TS / JVM", "8 clients p95 ms<br>TS / JVM"], rows), '</div>']
body += ['</div><p><small>Each number is the median of three independent run summaries. Eight clients continuously issue the next request after receiving the previous response; latency includes queuing. These are saturation results, not fixed-rate arrival tests. Tail estimates on the slowest cases have relatively few samples; raw counts and all run distributions are retained in the JSON.</small></p>']

body += ['<h3>The JVM throughput gain uses more CPU</h3>']
rows = []
for name in ("show", "list500", "complex", "edge"):
    row = [names[name]]
    for flavor in ("ts", "jvm"):
        cores = metric(flavor, 50000, name, 8, "cores")
        row.append(f"{cores:.2f}")
    rows.append(row)
body += [table(["50k, 8 clients", "TS average runtime cores", "JVM average runtime cores"], rows), '<p>TS executes synchronous graph work on one worker per weaver. Canonical requests can execute concurrently on JVM threads. Consequently this comparison measures both implementation cost and concurrency policy. It does not show that the JVM query code is seven times more efficient per CPU core.</p>']

body += ['<h3>Actual strand CLI calls</h3>']
rows = []
for name in ("show", "update", "complex"):
    concurrent = [next(m for m in extra["cliUnderLoad"] if m["flavor"] == f and m["name"] == name) for f in ("ts", "jvm")]
    rows.append([names[name], f"{metric('ts', 50000, name, 1, 'median', 'cli'):.2f}", f"{metric('jvm', 50000, name, 1, 'median', 'cli'):.2f}", f"{concurrent[0]['opsPerSecond']:.1f} / {concurrent[1]['opsPerSecond']:.1f}"])
body += [table(["50k", "TS CLI p50 ms<br>1 client", "JVM CLI p50 ms<br>1 client", "8 CLI clients ops/s<br>TS / JVM"], rows), '<p>Launching the CLI largely erases the point-read advantage seen at the socket. Fresh Go process per operation, stdout captured and parsed. The eight-client CLI figures are supplementary single runs in a four-member pool.</p><p><small>The socket tables exclude CLI launch while retaining production Mill routing, argv parsing, validation, SQLite, projection and JSON serialization.</small></p>']

body += ['<h3>Write durability is different by default</h3><p>The live TS connection uses SQLite 3.51.0 and <code>synchronous=NORMAL</code>; a connection opened with canonical’s actual datasource factory uses SQLite 3.53.2 and <code>synchronous=FULL</code>. This is a material caveat for native-default write comparisons. A supplementary fresh TS fixture was measured in each mode:</p>']
rows = []
for name in ("update", "add"):
    row = [names[name]]
    for mode in ("normal", "full"):
        m = next(m for m in extra["durability"] if m["name"] == name and m["synchronous"] == mode and m["concurrency"] == 8)
        row.append(f"{m['opsPerSecond']:,.1f}")
    row.append(f"{metric('jvm', 50000, name, 8, 'opsPerSecond'):,.1f}")
    rows.append(row)
body += [table(["8 clients, ops/s", "TS NORMAL", "TS FULL", "JVM FULL (main median)"], rows), '<p><small>The TS mode comparison is one three-second run per case, with 100 update warmups. It is diagnostic, not a repeated confidence estimate. Matching FULL did not erase TS’s write advantage on this machine. Other differences—JDBC connection lifecycle, revisions, IDs and validation—remain.</small></p>']

body += ['<h2>Does a busy weaver delay its sibling?</h2>']
rows = []
for r in extra["sibling"]:
    rows.append([r["flavor"], "Idle", f"{r['baseline']['latencyMs']['p95']:.2f}"])
    for load in r["underLoad"]:
        rows.append([r["flavor"], f"{load['hotClients']} clients querying another member", f"{load['probe']['latencyMs']['p95']:.2f}"])
body += [table(["4-member pool", "Load", "Sibling show p95 ms"], rows), '<p><small>Supplementary single run: 50k-strand compound queries in member 0; point reads in member 1 with 1k strands. The loaded member receives one or eight clients. This is equal client concurrency, not equal work rate: the JVM completes more heavy queries and consumes more CPU. These probes measure cross-member interference under each implementation’s saturation behavior.</small></p>']

body += ['<h2>Where the time goes</h2>']
hot = extra["profiles"]["tsHotpaths"]
rows = []
for name in ("list500", "selective", "complex", "edge"):
    row = [names[name]]
    for stage in ("prepared-id-query", "graph-list", "runtime-invoke", "json-stringify-result"):
        v = next(r for r in hot if r.get("name") == f"{name}:{stage}")
        row.append(f"{v['medianMs']:.2f}")
    rows.append(row)
body += [table(["TS, 50k", "Prepared ID SQL ms", "Graph list ms", "Public invoke ms", "JSON.stringify ms"], rows), '<p><small>Separate diagnostic process on a copy of a fresh seeded database, two seconds per stage after warmup. These stage measurements are not additive and exclude Mill/socket transport. Bun sampling is enabled for this diagnostic pass.</small></p>']
profile = json.loads(Path(extra["profiles"]["tsRecording"]).read_text())
nodes = {n["id"]: n for n in profile["nodes"]}
parents = {c: n["id"] for n in profile["nodes"] for c in n.get("children", [])}
categories = collections.Counter()
for node, count in collections.Counter(profile["samples"]).items():
    frames = []
    current = node
    while current in nodes:
        frames.append(nodes[current]["callFrame"])
        current = parents.get(current)
    if not any("/runtime/ops.ts" in f["url"] and f["functionName"] == "invoke" for f in frames):
        continue
    leaf = frames[0]
    category = "Zod" if "/zod/" in leaf["url"] else "SQLite" if not leaf["url"] and leaf["functionName"] in ("all", "get") else "other"
    categories[category] += count
total = sum(categories.values())
body += [f'<p><strong>Bun CPU sample:</strong> among {total:,} samples retaining a public <code>invoke</code> ancestor, {100 * categories["SQLite"] / total:.1f}% had a native SQLite <code>all/get</code> leaf and {100 * categories["Zod"] / total:.1f}% had a Zod leaf. Zod constructor/init and code-generation paths are prominent. This is a filtered view of the diagnostic, not a whole-process CPU percentage; other benchmark stages and async stacks lacking that ancestor are excluded.</p>']
events = json.loads((Path(extra["artifacts"]) / "jvm-events.json").read_text())["recording"]["events"]
samples = [e for e in events if e["type"] == "jdk.ExecutionSample" and e["values"]["stackTrace"]]
inclusive = collections.Counter()
for event in samples:
    classes = [f["method"]["type"]["name"] for f in event["values"]["stackTrace"]["frames"]]
    for name, prefix in (("JSON", "clojure/data/json"), ("spec", "clojure/spec")):
        if any(c.startswith(prefix) for c in classes): inclusive[name] += 1
body += [f'<p><strong>JVM JFR sample:</strong> {len(samples):,} Java execution samples under eight concurrent compound queries show substantial persistent-map/sequence work. JSON appears in {100 * inclusive["JSON"] / len(samples):.1f}% of those stacks and Clojure spec in {100 * inclusive["spec"] / len(samples):.1f}% (inclusive, potentially overlapping). Native samples also show SQLite stepping; idle socket-accept samples are not treated as CPU work. Recordings are retained alongside the raw measurements.</p>']
body += ['<p>Source inspection identifies useful follow-up work: batch TS row/attribute projection instead of two point queries per result; inspect repeated Zod schema construction and result validation; then consider read concurrency within a weaver if that workload matters. Both query compilers emit correlated EAV attribute predicates. TS also orders by <code>created_at,id</code>, whereas canonical orders by <code>id</code>; the TS diagnostic includes its actual query plans.</p>']

body += ['<h2>What this comparison covers</h2><ul>',
 '<li><strong>Data:</strong> 10,000 or 50,000 strands; eight typed attributes per strand, a 192-character body, nested metadata, and N−1 annotation edges. States/owners/priorities are deterministic. Every read case checks all returned IDs and attribute values against an independent expected result before timing.</li>',
 '<li><strong>Queries:</strong> return 500 by ordinal; active + owner; state + kind + priority + nested score + OR across two teams; outgoing edge whose endpoint is closed and has a given owner. The compound query returns 400/2,000 rows at 10k/50k. The edge query returns 62/312.</li>',
 '<li><strong>Limits:</strong> canonical raises an error on overflow while TS truncates. Every measured predicate selects fewer than the common explicit cap of 10,000, so both return the full matching set. Attributes stay below canonical’s 1,024-byte omission threshold.</li>',
 '<li><strong>Writes:</strong> update one attribute, or create a closed strand with two attributes. Writes run after queries. These are native product operations: TS includes revisions and UUIDs; canonical uses short IDs and its own guards/events. Batched writes and live agent spools are outside scope.</li>',
 '<li><strong>Defaults:</strong> disk-backed SQLite/WAL; TS keeps a persistent connection with a 2,000-page cache and mmap disabled; canonical uses JDBC and configures a 20 MiB page cache plus 256 MiB mmap. Synchronous modes differ as documented above. Java uses G1, a 256 MiB initial heap and a 4 GiB maximum (reserved capacity is not RSS). No matching of cache sizes, heap flags, GC or SQL schema. This compares shipped implementations, not language runtimes in isolation.</li>',
 '<li><strong>Timing:</strong> three fresh processes/databases per runtime and size; runtime order reverses in the middle round. Fifteen seconds of read warmup, three seconds per workload/client count, with in-flight requests allowed to finish. Independent Python client processes avoid a shared interpreter bottleneck. Profiles run separately from scored measurements.</li>',
 '<li><strong>Environment:</strong> one shared Mac, normal background apps, cooperative CPU lock held for each benchmark command. Dependency caches already warm. No swap/thermal isolation, confidence intervals, production workloads, long-duration soak, GC-normalized retained-heap measurement or cache-cold disk tests.</li>',
 '</ul>']
body += [f'<p><small>TS source <code>{main["tsCommit"]}</code>; canonical source <code>{main["canonicalCommit"]}</code>. Canonical source was not edited. Only disposable children were stopped; shared workspaces and services were not used.</small></p>']
body += [f'<p><strong>Verification:</strong> {sum(m["latencyMs"]["n"] for w in main["workloads"] for m in w["measurements"]):,} timed main-run requests completed without failures, in addition to preflight result checks. Profiling-specific lint/format and Python parsing pass. The full repository check stopped at an unrelated type error in a concurrently edited <code>spools/harnesses/src/catalog.ts:185</code> (<code>Reason[]</code> is not assignable to <code>Json</code>). Core, Batteries and CLI source stayed unchanged during measurement.</p>']
body += ['<details><summary>Reproduce and inspect raw results</summary><pre><code>qlock exec --lock /tmp/agent-cpu.lock -w 180 -- python3 scripts/profiling/weavers.py --output docs/weaver-profile.json\nqlock exec --lock /tmp/agent-cpu.lock -w 180 -- python3 -B scripts/profiling/followup.py docs/weaver-profile.json docs/weaver-profile-followup.json\nqlock exec --lock /tmp/agent-cpu.lock -w 180 -- python3 -B scripts/profiling/durability.py docs/weaver-profile.json docs/weaver-profile-followup.json</code></pre>',
 f'<p>Disposable databases, logs and CPU recordings: <code>{html.escape(main["artifacts"])}</code>. Benchmark scripts are under <code>scripts/profiling/</code>.</p>']
for title, data in (("Main results JSON", main), ("Follow-up results JSON", extra)):
    encoded = base64.b64encode(json.dumps(data, indent=2).encode()).decode()
    body += [f'<p><a download="{title.lower().replace(" ", "-")}.json" href="data:application/json;base64,{encoded}">{title}</a></p>']
body += ['</details>']
(out / "report-body.html").write_text("\n".join(body))
with (out / "summary.csv").open("w") as f:
    writer = csv.writer(f)
    writer.writerow(["strands", "flavor", "operation", "clients", "ops_per_second", "p50_ms", "p95_ms", "runtime_cpu_cores"])
    writer.writerows(csv_rows)
print(out / "report-body.html")
