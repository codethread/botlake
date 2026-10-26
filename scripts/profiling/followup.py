#!/usr/bin/env python3
"""Repeat idle measurements and sample hot paths after weavers.py has finished.

qlock exec --lock /tmp/agent-cpu.lock -w 180 -- python3 scripts/profiling/followup.py REPORT_JSON OUTPUT_JSON
"""
import json
import multiprocessing
from pathlib import Path
import sqlite3
import sys
import time

from weavers import ROOT, Runtime, command, log, measure, specs


report = json.loads(Path(sys.argv[1]).read_text())
output_path = Path(sys.argv[2])
base = Path(report["artifacts"])
canonical = Path(report["options"]["canonical"])
binaries = (base / "mill", base / "strand")
result = {"memory": [], "sibling": [], "cliUnderLoad": [], "profiles": {}, "artifacts": str(base)}


def save():
    output_path.write_text(json.dumps(result, indent=2) + "\n")


try:
    for repeat in range(2):
        for count in (1, 4, 8):
            for flavor in (("jvm", "ts") if repeat == 0 else ("ts", "jvm")):
                runtime = Runtime(flavor, base / f"m{repeat}{flavor[0]}{count}", canonical, binaries, count)
                try:
                    runtime.start()
                    record = {"flavor": flavor, "weavers": count, "pooled": True,
                              "repeat": repeat + 1, "startupMs": runtime.startup_ms,
                              "idle": runtime.idle()}
                    result["memory"].append(record)
                    save()
                    log(f"{flavor} idle repeat {repeat + 1}, {count}: {record['idle']['runtimeRssMiB']['median']:.1f} MiB")
                finally:
                    runtime.close()

    runtime = Runtime("jvm", base / "isol4", canonical, binaries, 4, pooled=False)
    try:
        runtime.start()
        result["memory"].append({"flavor": "jvm", "weavers": 4, "pooled": False,
                                 "startupMs": runtime.startup_ms, "idle": runtime.idle()})
        save()
    finally:
        runtime.close()

    for flavor in ("ts", "jvm"):
        runtime = Runtime(flavor, base / f"sib{flavor[0]}", canonical, binaries, 4)
        try:
            runtime.start()
            runtime.seed(50000)
            runtime.seed(1000, workspace=1)
            hot_op, hot_data = specs(50000)["complex"]
            probe_op, probe_data = specs(1000)["show"]
            until = time.monotonic() + 10
            while time.monotonic() < until:
                runtime.invoke(hot_op, hot_data)
                runtime.invoke(probe_op, probe_data, workspace=1)
            record = {"flavor": flavor, "weavers": 4,
                      "baseline": measure(runtime, probe_op, probe_data, 3, 1, workspace=1),
                      "underLoad": []}
            for hot_clients in (1, 8):
                context = multiprocessing.get_context("fork")
                receiver, sender = context.Pipe(duplex=False)
                def background():
                    try:
                        sender.send(measure(runtime, hot_op, hot_data, 7, hot_clients))
                    except Exception as error:
                        sender.send({"error": str(error)})
                child = context.Process(target=background)
                child.start()
                sender.close()
                time.sleep(1.5)
                probe = measure(runtime, probe_op, probe_data, 3, 1, workspace=1)
                load = receiver.recv()
                child.join()
                receiver.close()
                if "error" in load:
                    raise RuntimeError(load["error"])
                record["underLoad"].append({"hotClients": hot_clients, "probe": probe, "load": load})
                log(f"{flavor} sibling p95 under c{hot_clients}: {probe['latencyMs']['p95']:.2f} ms")
            result["sibling"].append(record)
            save()

            if flavor == "jvm":
                pid, = runtime.runtime_pids
                result["profiles"]["jvmFlags"] = command(["jcmd", str(pid), "VM.flags"])
                result["profiles"]["jvmVersion"] = command(["jcmd", str(pid), "VM.version"])
                recording = base / "jvm-complex.jfr"
                command(["jcmd", str(pid), "JFR.start", "name=complex", "settings=profile", f"filename={recording}"])
                measure(runtime, hot_op, hot_data, 12, 8)
                command(["jcmd", str(pid), "JFR.stop", "name=complex"])
                events = command(["jfr", "print", "--json", "--events", "jdk.ExecutionSample,jdk.NativeMethodSample", recording])
                (base / "jvm-events.json").write_text(events)
                result["profiles"]["jvmRecording"] = str(recording)
            else:
                copy = base / "ts-diagnostic.db"
                with sqlite3.connect(runtime.database()) as source, sqlite3.connect(copy) as destination:
                    source.backup(destination)
                (base / "queries.json").write_text(json.dumps(specs(50000)))
                result["profiles"]["tsDatabaseCopy"] = str(copy)
            for name in ("show", "update", "complex"):
                op, data = specs(50000)[name]
                metric = measure(runtime, op, data, 3, 8, cli=True)
                result["cliUnderLoad"].append({"flavor": flavor, "name": name, **metric})
                log(f"{flavor} CLI c8 {name}: {metric['opsPerSecond']:.1f}/s")
            save()
        finally:
            runtime.close()

    log("Sampling Bun graph and operation hot paths")
    output = command(["bun", "--cpu-prof", f"--cpu-prof-dir={base}",
                      "--cpu-prof-name=ts-hotpaths.cpuprofile", ROOT / "scripts/profiling/ts-hotpaths.ts",
                      base / "ts-diagnostic.db", base / "queries.json"], timeout=180)
    result["profiles"]["tsHotpaths"] = json.loads(output)
    result["profiles"]["tsRecording"] = str(base / "ts-hotpaths.cpuprofile")
finally:
    save()
    log(f"Follow-up report: {output_path}")
