#!/usr/bin/env python3
"""Supplement native-default results with a TS NORMAL/FULL write comparison.

Run under qlock, passing the main JSON and follow-up JSON as arguments.
"""
import json
from pathlib import Path
import sys

from weavers import Runtime, command, log, measure, specs

main = json.loads(Path(sys.argv[1]).read_text())
output = Path(sys.argv[2])
extra = json.loads(output.read_text())
base = Path(main["artifacts"])
canonical = Path(main["options"]["canonical"])
spool = '''import {defineOp} from "@millstrand/core";
import {z} from "zod";
export default {name:"profile-durability",activate(ctx){
  for(const mode of ["NORMAL","FULL"]){ctx.register(defineOp({
    name:"profile-"+mode.toLowerCase(),input:z.object({}),output:z.number(),
    cli:{description:"Select SQLite synchronous mode for this disposable benchmark"},
    handler(){ctx.graph.db.run("PRAGMA synchronous="+mode);
      return z.object({synchronous:z.number()}).parse(ctx.graph.db.query("PRAGMA synchronous").get()).synchronous;}
  }));}
}};'''
extra["durability"] = []
settings_script = base / "jdbc-settings.clj"
settings_script.write_text('''(require '[millstrand.core.db :as db] '[next.jdbc :as jdbc] '[clojure.data.json :as json])
(with-open [c (jdbc/get-connection (db/datasource DB_FILE))]
  (println (json/write-str (into {} (map (fn [[k sql]] [k (jdbc/execute-one! c [sql])])
    [["version" "SELECT sqlite_version() AS version"] ["journal_mode" "PRAGMA journal_mode"]
     ["synchronous" "PRAGMA synchronous"] ["cache_size" "PRAGMA cache_size"] ["mmap_size" "PRAGMA mmap_size"]])))))
'''.replace("DB_FILE", json.dumps(str(base / "jdbc-settings.sqlite"))))
settings = json.loads(command(["clojure", "-Srepro", "-M", settings_script], cwd=canonical))
extra["profiles"]["jvmSqlite"] = {k: next(iter(v.values())) for k, v in settings.items()}
for mode, expected in (("normal", 1), ("full", 2)):
    runtime = Runtime("ts", base / f"sync-{mode}", canonical, (base / "mill", base / "strand"), spool_source=spool)
    try:
        runtime.start()
        runtime.seed(50000)
        actual, _ = runtime.invoke("profile-" + mode, {})
        if actual != expected:
            raise RuntimeError(f"Unexpected synchronous mode: {actual}")
        for i in range(100):
            runtime.invoke("update", {"id": "b0000000", "attributes": {"profileCounter": i}})
        for name in ("update", "add"):
            operation, data = specs(50000)[name]
            for concurrency in (1, 8):
                metric = measure(runtime, operation, data, 3, concurrency)
                extra["durability"].append({"name": name, "synchronous": mode, **metric})
                log(f"TS {mode} {name} c{concurrency}: {metric['opsPerSecond']:.1f}/s")
    finally:
        runtime.close()
        output.write_text(json.dumps(extra, indent=2) + "\n")
