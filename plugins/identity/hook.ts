import { z } from "zod";

import { antigravityHook, antigravityPassThrough } from "./adapters/antigravity.ts";
import { claude } from "./adapters/claude.ts";
import { codex } from "./adapters/codex.ts";
import { hookEventSchema } from "./adapters/events.ts";
import { reportNative } from "./session.ts";

const adapters = { codex, claude };
const hookProviderSchema = z.compile(z.enum(["codex", "claude", "antigravity"]));
const provider = hookProviderSchema.parse(Bun.argv[2]);
const eventName = Bun.argv[3];
let output: unknown = {};
try {
  const payload: unknown = await Bun.stdin.json();
  if (provider === "antigravity") {
    output = await antigravityHook(eventName, payload, process.env, reportNative);
  } else {
    const adapter = adapters[provider];
    const input = hookEventSchema.parse(payload);
    if (input.agent_id === undefined) {
      const event = adapter.decode(input);
      const report = await reportNative(event.observation, process.env, event.unmanaged);
      output = await adapter.deliver(event, report, process.env);
    }
  }
} catch (error) {
  // A malformed host event is visible, but an attribution integration never blocks native work.
  const systemMessage = `Botlake native adapter failed: ${String(error)}`;
  process.stderr.write(`${systemMessage}\n`);
  output = provider === "antigravity" ? antigravityPassThrough(eventName) : { systemMessage };
}
process.stdout.write(`${JSON.stringify(output)}\n`);
