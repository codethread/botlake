import { z } from "zod";

import { commandSchema, type BuiltinProviderOptions, type Provider } from "./contract.ts";
import { jsonLines, malformedOutput, nativeSession, result } from "./output.ts";

const itemSchema = z.compile(z.object({ type: z.string(), text: z.string().optional() }));

export function codex(options: BuiltinProviderOptions = {}): Provider {
  const command = commandSchema.parse(options.command ?? ["codex"]);
  return {
    name: "codex",
    ...(options.flag === undefined ? {} : { flag: options.flag }),
    doc: "Codex CLI. Uses the provider's default model unless an alias selects one.",

    prepare(run) {
      const args = [...run.extraArgs];
      if (run.model !== undefined) args.push("--model", run.model);
      if (run.effort !== undefined)
        args.push("--config", `model_reasoning_effort=${JSON.stringify(run.effort)}`);
      if (run.systemPrompt.length > 0)
        args.push("--config", `developer_instructions=${JSON.stringify(run.systemPrompt)}`);
      return {
        command: [
          ...command,
          "exec",
          "--json",
          ...args,
          ...(run.resumes ? ["resume", run.sessionId, "-"] : []),
        ],
        stdin: `${run.prompt}\n`,
        env: {},
      };
    },

    finish(_run, exitCode, stdout, stderr) {
      // Report evidence from this invocation, never the requested resume id.
      let sessionId: string | null = null;

      try {
        const decoded = jsonLines(stdout);
        const { events } = decoded;
        const observed = nativeSession(events, "thread.started", "thread_id");
        sessionId = observed;

        const messages = events
          .filter((event) => event["type"] === "item.completed")
          .map((event) => itemSchema.parse(event["item"]))
          .filter((item) => item.type === "agent_message");

        const failure = events.find(
          (event) => event["type"] === "turn.failed" || event["type"] === "error",
        );
        return result(
          exitCode === 0 && failure === undefined && decoded.error === null && observed !== null,
          messages.at(-1)?.text,
          sessionId,
          exitCode !== 0
            ? stderr.length > 0
              ? stderr
              : `Codex exited ${exitCode}`
            : failure !== undefined
              ? JSON.stringify(failure)
              : (decoded.error ?? (observed === null ? "Codex returned no thread id" : null)),
        );
      } catch (error) {
        return malformedOutput("codex", sessionId, error);
      }
    },
  };
}
