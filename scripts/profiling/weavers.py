#!/usr/bin/env python3
"""Compare real Batteries weavers using disposable SQLite databases.

Run under qlock; see --help. Only child processes created by this harness are
signalled. Canonical source is read-only. No shared Mill or workspace is used.
Seeding writes equivalent logical fixtures directly to each native schema;
timed operations always use the public CLI or the same Mill invoke protocol.
"""

import argparse
import hashlib
import json
import math
import multiprocessing
import os
from pathlib import Path
import platform
import socket
import sqlite3
import statistics
import subprocess
import tempfile
import time
import uuid


ROOT = Path(__file__).resolve().parents[2]


def command(argv, *, cwd=ROOT, env=None, timeout=180):
    p = subprocess.run([str(x) for x in argv], cwd=cwd, env=env,
                       capture_output=True, text=True, timeout=timeout)
    if p.returncode:
        raise RuntimeError(f"{argv}: {p.stderr}\n{p.stdout}")
    return p.stdout


def log(message):
    print(f"{time.strftime('%H:%M:%S')} {message}", flush=True)


def distribution(values):
    ordered = sorted(values)
    return {"n": len(values), "median": statistics.median(values),
            "p95": ordered[math.ceil(len(values) * .95) - 1],
            "p99": ordered[math.ceil(len(values) * .99) - 1],
            "max": ordered[-1]}


def processes():
    rows = command(["ps", "-axo", "pid=,ppid=,rss=,time=,comm="])
    result = {}
    for row in rows.splitlines():
        pid, ppid, rss, cpu, name = row.split(None, 4)
        parts = cpu.replace("-", ":").split(":")
        seconds = sum(float(v) * 60 ** i for i, v in enumerate(reversed(parts)))
        result[int(pid)] = {"pid": int(pid), "ppid": int(ppid),
                            "rssMiB": int(rss) / 1024, "cpuSeconds": seconds,
                            "command": name}
    return result


def descendants(pid, rows):
    found = {pid}
    while True:
        more = {p for p, row in rows.items() if row["ppid"] in found}
        if more <= found:
            return found
        found |= more


def predicate(op, field, value):
    return {"op": op, "field": field, "value": value}


def attr(name, *path):
    return {"attr": name, "path": list(path)}


def canonical_predicate(p):
    op = p["op"]
    if op in ("and", "or"):
        return [op, *map(canonical_predicate, p["args"])]
    if op == "edge":
        return ["edge/" + p["direction"], p["relation"], canonical_predicate(p["where"])]
    field = p["field"]
    if isinstance(field, dict):
        field = ["attr", field["attr"], *field["path"]]
    return [op, field, p["value"]]


def attributes(i):
    return {"kind": "feature" if i % 10 == 0 else "task",
            "owner": f"agent-{i % 32}", "priority": i % 5,
            "team": f"team-{(i // 5) % 8}",
            "meta": {"score": i % 100, "region": "eu" if i % 3 else "us"},
            "body": "x" * 192, "ordinal": i, "flag": i % 2 == 0}


def ident(i):
    return f"b{i:07d}"


def specs(n):
    simple = {"op": "and", "args": [predicate("=", "state", "active"),
        predicate("=", attr("owner"), "agent-7")]}
    complex_filter = {"op": "and", "args": [
        predicate("=", "state", "active"), predicate("=", attr("kind"), "task"),
        predicate(">=", attr("priority"), 3), predicate(">=", attr("meta", "score"), 60),
        {"op": "or", "args": [predicate("=", attr("team"), "team-2"),
                                predicate("=", attr("team"), "team-5")]},
    ]}
    edge = {"op": "and", "args": [predicate("=", "state", "active"),
        {"op": "edge", "direction": "out", "relation": "ref", "where": {
            "op": "and", "args": [predicate("=", "state", "closed"),
                predicate("=", attr("owner"), "agent-0")]}}]}
    return {
        "show": ("show", {"id": ident(n // 2)}),
        "list500": ("list", {"where": predicate("<", attr("ordinal"), 500), "limit": 10000}),
        "selective": ("list", {"where": simple, "limit": 10000}),
        "complex": ("list", {"where": complex_filter, "limit": 10000}),
        "edge": ("list", {"where": edge, "limit": 10000}),
        "update": ("update", {"id": ident(n // 2), "attributes": {"profileCounter": 1}}),
        "add": ("add", {"title": "profile-write", "state": "closed",
                         "attributes": {"kind": "noise", "body": "x" * 192}}),
    }


class Runtime:
    def __init__(self, flavor, base, canonical, binaries, count=1, pooled=True, spool_source=None):
        self.flavor = flavor
        self.base = base
        self.canonical = canonical
        self.count = count
        self.pooled = pooled
        self.spool_source = spool_source
        self.base.mkdir()
        self.env = dict(os.environ)
        self.workspaces = []
        if flavor == "ts":
            self.mill = ROOT / "out/mill"
            self.strand = ROOT / "out/strand"
            self.env.update(MILL_HOME=str(base / "home"),
                            MILLSTRAND_CORE=str(ROOT / "packages/core"))
            self.socket = base / "home/mill.sock"
        else:
            self.mill, self.strand = binaries
            self.env["XDG_STATE_HOME"] = str(base / "s")
            self.socket = base / "s/millstrand/mill.sock"
        self.logfile = open(base / "mill.log", "w")
        self.daemon = subprocess.Popen([str(self.mill), "start"], cwd=base,
            env=self.env, stdout=self.logfile, stderr=subprocess.STDOUT)
        self.runtime_pids = set()

    def mill_call(self, *args):
        return json.loads(command([self.mill, *args], cwd=self.base, env=self.env))

    def start(self):
        deadline = time.monotonic() + 30
        while not self.socket.exists():
            if self.daemon.poll() is not None or time.monotonic() > deadline:
                raise RuntimeError((self.base / "mill.log").read_text())
            time.sleep(.05)
        if self.flavor == "jvm":
            self.meta = json.loads((self.base / "s/millstrand/mill.json").read_text())
        for index in range(self.count):
            ws = self.base / f"w{index}"
            config = ws / ".millstrand"
            config.mkdir(parents=True)
            self.workspaces.append(ws)
            if self.flavor == "ts":
                (ws / "node_modules").symlink_to(ROOT / "node_modules", target_is_directory=True)
                spools = ["@millstrand/spool-batteries"]
                if self.spool_source is not None:
                    (ws / "profile.ts").write_text(self.spool_source)
                    spools.append("./profile.ts")
                (config / "config.json").write_text(json.dumps({"name": f"w{index}",
                    "spools": spools}))
            else:
                (config / "config.json").write_text(json.dumps({"configFormat": "alpha", "name": f"w{index}"}))
                (config / "deps.edn").write_text('{:deps {io.millstrand/batteries {:local/root '
                    + json.dumps(str(self.canonical / "spools/batteries")) + '}}}')
                (config / "init.clj").write_text("(require '[millstrand.api.current.alpha :as current] "
                    "'[millstrand.api.runtime.alpha :as runtime])\n"
                    "(runtime/module! (current/runtime) :millstrand/spools-batteries "
                    "{:ns 'millstrand.spools.batteries :required? true})\n")
                if self.pooled:
                    self.mill_call("init", "--workspace", str(config), "--jvm-pool", "profile")
        started = time.perf_counter()
        for ws in self.workspaces:
            args = ["weaver", "start", "--workspace", str(ws if self.flavor == "ts" else ws / ".millstrand")]
            if self.flavor == "jvm":
                args += ["--json"]
            self.mill_call(*args)
            if self.flavor == "jvm" and self.pooled:
                break
        self.startup_ms = (time.perf_counter() - started) * 1000
        rows = processes()
        self.runtime_pids = descendants(self.daemon.pid, rows) - {self.daemon.pid}
        self.runtime_pids = {p for p in self.runtime_pids if "java" in rows[p]["command"] or "bun" in rows[p]["command"]}
        if not self.runtime_pids:
            raise RuntimeError(f"No weaver processes found: {rows[self.daemon.pid]}")
        log(f"{self.flavor} ready: {self.count} weavers, {self.startup_ms:.0f} ms, PIDs {self.runtime_pids}")

    def usage(self):
        rows = processes()
        selected = [rows[p] for p in self.runtime_pids]
        return {"runtimeRssMiB": sum(p["rssMiB"] for p in selected),
                "runtimeCpuSeconds": sum(p["cpuSeconds"] for p in selected),
                "millRssMiB": rows[self.daemon.pid]["rssMiB"], "processes": selected}

    def idle(self, settle=10, samples=5):
        time.sleep(settle)
        records = []
        for _ in range(samples):
            records.append(self.usage())
            time.sleep(1)
        return {"settleSeconds": settle, "samples": records,
                "runtimeRssMiB": distribution([r["runtimeRssMiB"] for r in records]),
                "millRssMiB": distribution([r["millRssMiB"] for r in records])}

    def database(self, workspace=0):
        if self.flavor == "ts":
            return self.workspaces[workspace] / ".millstrand/world.db"
        files = list((self.base / "s").rglob("weaver.json"))
        for path in files:
            meta = json.loads(path.read_text())
            if Path(meta["config_dir"]).resolve() == (self.workspaces[workspace] / ".millstrand").resolve():
                return Path(meta["database_path"])
        raise RuntimeError(f"No database metadata under {self.base}")

    def seed(self, n, workspace=0):
        path = self.database(workspace)
        if not path.exists():
            raise RuntimeError(f"Database not found: {path}")
        with sqlite3.connect(path) as db:
            db.execute("PRAGMA foreign_keys=ON")
            first = db.execute("SELECT count(*) FROM strands").fetchone()[0]
            if first:
                raise RuntimeError("Fixture database must be empty")
            stamp = "2026-01-01T00:00:00.000Z"
            columns = "id,title,state,created_at,updated_at"
            if self.flavor == "ts":
                columns += ",revision"
            values = [(ident(i), f"Task {i:07d}", "closed" if i % 5 == 0 else "active", stamp, stamp)
                      + ((1,) if self.flavor == "ts" else ()) for i in range(n)]
            db.executemany(f"INSERT INTO strands({columns}) VALUES({','.join('?' for _ in values[0])})", values)
            db.executemany("INSERT INTO attributes(strand_id,key,value,archived) VALUES(?,?,?,0)",
                ((ident(i), k, json.dumps(v, separators=(",", ":"))) for i in range(n) for k, v in attributes(i).items()))
            edge_table = "edges" if self.flavor == "ts" else "strand_edges"
            db.executemany(f"INSERT INTO {edge_table} VALUES(?,?,?,?)",
                ((ident(i), ident(i + 1), "ref", "{}") for i in range(n - 1)))
            db.commit()
            result = {"strands": n, "attributes": n * 8, "edges": n - 1,
                      "fixtureSqlite": sqlite3.sqlite_version, "databaseBytes": path.stat().st_size}
        log(f"{self.flavor} seeded {n} strands")
        return result

    def argv(self, operation, data):
        args = []
        if operation in ("show", "update"):
            args.append(data["id"])
        if operation == "add":
            args.append(data["title"])
        for key in ("state", "attributes", "where", "limit"):
            if key not in data:
                continue
            value = data[key]
            if key == "where" and self.flavor == "jvm":
                value = canonical_predicate(value)
            args += ["--" + key, json.dumps(value, separators=(",", ":")) if key in ("attributes", "where") else str(value)]
        return args

    def invoke(self, operation, data, *, cli=False, workspace=0):
        ws = str(self.workspaces[workspace] if self.flavor == "ts" else self.workspaces[workspace] / ".millstrand")
        argv = self.argv(operation, data)
        if cli:
            raw = command([self.strand, "--workspace", ws, operation, *argv],
                          cwd=self.base, env=self.env, timeout=60)
            return json.loads(raw), len(raw.encode())
        # Both paths include the production Mill router, argument parsing,
        # validation, DB access, projection and JSON response serialization.
        payload = {"name": operation, "argv": argv}
        if self.flavor == "ts":
            frame = {"protocol_version": 1, "request_id": str(uuid.uuid4()),
                "operation": "invoke", "workspace": ws, "payload": payload}
        else:
            payload.update(payloads={}, cwd=self.base.as_posix(),
                           client={"pid": os.getpid(), "version": "profile", "build_id": "profile"},
                           is_tty=False, tty_col=None)
            frame = {"protocol_version": 3, "request_id": str(uuid.uuid4()),
                "mill_id": self.meta["mill_id"], "operation": "invoke",
                "world": {"config_dir": str(self.workspaces[workspace] / ".millstrand"),
                          "cwd": self.base.as_posix()}, "payload": payload}
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.settimeout(60)
            connection.connect(str(self.socket))
            connection.sendall(json.dumps(frame, separators=(",", ":")).encode() + b"\n")
            raw = connection.makefile("rb").readline()
        response = json.loads(raw)
        if not response.get("ok"):
            raise RuntimeError(f"{self.flavor} {operation}: {response}")
        return response["result"], len(raw)

    def close(self):
        # Send SIGTERM only to the disposable supervisor we created; its
        # normal shutdown joins its own weavers. No global `mill stop` call.
        if self.daemon.poll() is None:
            self.daemon.terminate()
            try:
                self.daemon.wait(timeout=30)
            except subprocess.TimeoutExpired:
                for pid in self.runtime_pids:
                    os.kill(pid, 15)
                self.daemon.kill()
                self.daemon.wait()
        self.logfile.close()


def measure(runtime, operation, data, duration, concurrency, cli=False, workspace=0):
    # Closed-loop clients: each immediately issues the next request after a
    # response. This measures saturation, not latency at a fixed arrival rate.
    context = multiprocessing.get_context("fork")
    barrier = context.Barrier(concurrency + 1)
    def worker(index, connection):
        latencies, sizes = [], []
        barrier.wait()
        started = time.perf_counter()
        cpu = time.process_time()
        deadline = started + duration
        try:
            while time.perf_counter() < deadline:
                value = data
                if operation == "update":
                    value = {**data, "id": ident(index), "attributes": {"profileCounter": len(latencies)}}
                began = time.perf_counter()
                _, size = runtime.invoke(operation, value, cli=cli, workspace=workspace)
                latencies.append((time.perf_counter() - began) * 1000)
                sizes.append(size)
            connection.send({"latencies": latencies, "sizes": sizes, "started": started,
                             "ended": time.perf_counter(), "cpuSeconds": time.process_time() - cpu})
        except Exception as error:
            connection.send({"error": str(error)})
        finally:
            connection.close()
    before = runtime.usage()
    children = []
    connections = []
    for i in range(concurrency):
        receiver, sender = context.Pipe(duplex=False)
        child = context.Process(target=worker, args=(i, sender))
        child.start()
        sender.close()
        children.append(child)
        connections.append(receiver)
    barrier.wait()
    results = [connection.recv() for connection in connections]
    for child, connection in zip(children, connections):
        child.join()
        connection.close()
    for result in results:
        if "error" in result:
            raise RuntimeError(result["error"])
    elapsed = max(r["ended"] for r in results) - min(r["started"] for r in results)
    after = runtime.usage()
    latencies = [x for r in results for x in r["latencies"]]
    sizes = [x for r in results for x in r["sizes"]]
    return {"concurrency": concurrency, "transport": "cli" if cli else "mill-socket",
        "seconds": elapsed, "opsPerSecond": len(latencies) / elapsed,
        "latencyMs": distribution(latencies), "meanResponseBytes": statistics.mean(sizes),
        "runtimeCpuSeconds": after["runtimeCpuSeconds"] - before["runtimeCpuSeconds"],
        "clientCpuSeconds": sum(r["cpuSeconds"] for r in results),
        "runtimeRssMiB": after["runtimeRssMiB"], "errors": 0}


def validate(runtime, n):
    results = {}
    for name, (op, data) in specs(n).items():
        if name in ("add", "update"):
            continue
        value, size = runtime.invoke(op, data)
        rows = value if isinstance(value, list) else [value]
        ids = sorted(row["id"] for row in rows)
        if name == "show":
            expected = [ident(n // 2)]
        elif name == "list500":
            expected = [ident(i) for i in range(min(n, 500))]
        elif name == "selective":
            expected = [ident(i) for i in range(n) if i % 5 and i % 32 == 7]
        elif name == "complex":
            expected = [ident(i) for i in range(n) if i % 5 >= 3 and i % 100 >= 60 and (i // 5) % 8 in (2, 5)]
        else:
            expected = [ident(i) for i in range(n - 1) if i % 5 and (i + 1) % 5 == 0 and (i + 1) % 32 == 0]
        if ids != expected:
            raise RuntimeError(f"{runtime.flavor} {name} wrong IDs: {ids[:5]} ({len(ids)}) expected {expected[:5]} ({len(expected)})")
        for row in rows:
            i = int(row["id"][1:])
            if row["attributes"] != attributes(i):
                raise RuntimeError(f"{runtime.flavor} attributes differ: {row}")
        results[name] = {"rows": len(ids), "responseBytes": size,
            "idDigest": hashlib.sha256(json.dumps(ids).encode()).hexdigest()}
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--canonical", type=Path, default=Path.home() / "dev/projects/skein-src")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--sizes", default="10000,50000")
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--seconds", type=float, default=3)
    parser.add_argument("--idle-counts", default="1,4,8")
    parser.add_argument("--settle", type=float, default=10)
    parser.add_argument("--pilot", action="store_true")
    parser.add_argument("--flavors", default="ts,jvm")
    parser.add_argument("--isolated", action="store_true", help="Use separate JVMs instead of a JVM pool")
    args = parser.parse_args()
    base = Path(tempfile.mkdtemp(prefix="msp-", dir="/tmp"))
    log(f"Artifacts and disposable state: {base}")
    binaries = (base / "mill", base / "strand")
    for name, binary in zip(("mill", "strand"), binaries):
        command(["go", "build", "-ldflags", f"-X millstrand-strand-cli/internal/config.InstalledSource={args.canonical}",
                 "-o", binary, f"./cli/cmd/{name}"], cwd=args.canonical)
    output = {"date": time.strftime("%Y-%m-%d"), "machine": platform.platform(),
        "cpu": command(["sysctl", "-n", "machdep.cpu.brand_string"]).strip(),
        "logicalCpus": os.cpu_count(), "physicalMemoryBytes": int(command(["sysctl", "-n", "hw.memsize"])),
        "bun": command(["bun", "--version"]).strip(),
        "java": subprocess.run(["java", "-version"], capture_output=True, text=True).stderr.strip(),
        "tsCommit": command(["git", "rev-parse", "HEAD"]).strip(),
        "canonicalCommit": command(["git", "rev-parse", "HEAD"], cwd=args.canonical).strip(),
        "artifacts": str(base), "options": {k: str(v) if isinstance(v, Path) else v for k, v in vars(args).items()},
        "memory": [], "workloads": []}
    def save():
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(output, indent=2) + "\n")
    save()
    try:
        counts = [] if args.pilot else [int(n) for n in args.idle_counts.split(",") if n]
        flavors = args.flavors.split(",")
        for count in counts:
            for flavor in flavors:
                runtime = Runtime(flavor, base / f"i{flavor[0]}{count}", args.canonical, binaries, count, not args.isolated)
                try:
                    runtime.start()
                    record = {"flavor": flavor, "weavers": count, "pooled": flavor == "ts" or not args.isolated,
                              "startupMs": runtime.startup_ms, "idle": runtime.idle(args.settle)}
                    output["memory"].append(record)
                    save()
                    log(f"{flavor} idle {count}: {record['idle']['runtimeRssMiB']['median']:.1f} MiB")
                finally:
                    runtime.close()
        sizes = [int(n) for n in args.sizes.split(",")]
        for repeat in range(args.repeats):
            for n in sizes:
                for flavor in (flavors if repeat % 2 == 0 else list(reversed(flavors))):
                    runtime = Runtime(flavor, base / f"r{repeat}{flavor[0]}{n}", args.canonical, binaries)
                    try:
                        runtime.start()
                        record = {"flavor": flavor, "strands": n, "repeat": repeat,
                            "startupMs": runtime.startup_ms, "seed": runtime.seed(n),
                            "validation": validate(runtime, n), "measurements": []}
                        output["workloads"].append(record)
                        # Explicit time-based warmup lets JVM compilation and
                        # the SQLite page cache settle before recording latency.
                        all_specs = specs(n)
                        warmup_until = time.monotonic() + (1 if args.pilot else 15)
                        while time.monotonic() < warmup_until:
                            for name, (op, data) in all_specs.items():
                                if name not in ("add", "update"):
                                    runtime.invoke(op, data)
                        record["seededIdle"] = runtime.idle(1 if args.pilot else args.settle, 2 if args.pilot else 5)
                        for name, (op, data) in all_specs.items():
                            for concurrency in (1, 8):
                                metric = measure(runtime, op, data, args.seconds, concurrency)
                                metric["name"] = name
                                record["measurements"].append(metric)
                                log(f"{flavor} n={n} {name} c={concurrency}: {metric['opsPerSecond']:.1f}/s p50={metric['latencyMs']['median']:.2f} p95={metric['latencyMs']['p95']:.2f} ms")
                                save()
                            if name in ("show", "update", "complex"):
                                metric = measure(runtime, op, data, args.seconds, 1, cli=True)
                                metric["name"] = name
                                record["measurements"].append(metric)
                                save()
                        record["postLoadIdle"] = runtime.idle(1 if args.pilot else args.settle, 2 if args.pilot else 5)
                        save()
                    finally:
                        runtime.close()
    finally:
        save()
        log(f"Report: {args.output}; diagnostic logs/state retained: {base}")


if __name__ == "__main__":
    main()
