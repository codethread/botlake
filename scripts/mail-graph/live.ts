import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { system } from "../../tests/blackbox/fixtures/system.ts";
import { root, mailLake } from "./fixture.ts";
import { runPeers } from "./peers.ts";
const output = join(root, "out/mail-graph/live");
await mkdir(output, { recursive: true });
const fixture = await system();
try {
  const workspace = await mailLake(fixture, "graph-live");
  console.log(JSON.stringify(await runPeers(fixture, workspace, output)));
} finally {
  await fixture.close();
}
