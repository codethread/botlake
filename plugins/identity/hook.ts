import { providerSchema } from "@botlake/native-session";
import { z } from "zod";

import { claude } from "./adapters/claude.ts";
import { codex } from "./adapters/codex.ts";
import { reportNative } from "./session.ts";

const adapters = { codex, claude };
const hookProviderSchema = z.compile(providerSchema.extract(["codex", "claude"]));
const provider = hookProviderSchema.parse(Bun.argv[2]);
try {
  const adapter = adapters[provider];
  const event = adapter.decode(await Bun.stdin.json());
  const report = await reportNative(event.observation, process.env, event.unmanaged);
  process.stdout.write(`${JSON.stringify(await adapter.deliver(event, report, process.env))}\n`);
} catch (error) {
  // A malformed host event is visible, but an attribution integration never blocks native work.
  process.stderr.write(`Botlake native adapter failed: ${String(error)}\n`);
  process.stdout.write(
    `${JSON.stringify({ systemMessage: `Botlake native adapter failed: ${String(error)}` })}\n`,
  );
}
