import { registerNative } from "@botlake/identity/client";
import { z } from "zod";

try {
  const event = z
    .object({ session_id: z.string().min(1), model: z.string().optional() })
    .parse(await Bun.stdin.json());
  const binding = await registerNative({
    provider: "cursor",
    nativeSessionId: event.session_id,
    cwd: z.string().min(1).parse(process.env["CURSOR_PROJECT_DIR"]),
    ...(event.model === undefined ? {} : { model: event.model }),
  });
  const context = [binding?.instruction, process.env["BOTLAKE_HARNESS_CURSOR_SYS_PROMPT"]]
    .filter((part) => part !== undefined && part.length > 0)
    .join("\n\n");
  process.stdout.write(`${JSON.stringify({ additional_context: context })}\n`);
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({ user_message: `Botlake identity startup failed: ${String(error)}; this session is unbound.` })}\n`,
  );
  process.exitCode = 1;
}
