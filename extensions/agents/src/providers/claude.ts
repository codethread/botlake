import { z } from "zod";

import type { Provider } from "./contract.ts";
import { malformedOutput, result } from "./output.ts";

export const claude: Provider = {
  name: "claude",
  doc: "Claude Code CLI. Uses the provider's default model unless an alias selects one.",

  prepare(run) {
    const options = [...run.extraArgs];
    if (run.model !== undefined) options.push("--model", run.model);
    if (run.effort !== undefined) options.push("--effort", run.effort);
    for (const prompt of run.systemPrompts) options.push("--append-system-prompt", prompt);

    return {
      command: [
        "claude",
        "--print",
        "--output-format",
        "json",
        ...options,
        ...(run.resumes ? ["--resume", run.sessionId] : []),
      ],
      stdin: `${run.prompt}\n`,
      env: {},
    };
  },

  finish(_run, exitCode, stdout, stderr) {
    // Report evidence from this invocation, never the requested resume id.
    try {
      const envelope = z
        .object({
          session_id: z.string().optional(),
          result: z.string().optional(),
          is_error: z.boolean().optional(),
        })
        .parse(JSON.parse(stdout));
      const observed = envelope.session_id !== undefined && envelope.session_id.trim().length > 0;

      return result(
        exitCode === 0 && envelope.is_error !== true && observed,
        envelope.result,
        observed ? envelope.session_id : null,
        exitCode !== 0 || envelope.is_error === true
          ? stderr.length > 0
            ? stderr
            : "Provider failed"
          : observed
            ? null
            : "Provider returned no session id",
      );
    } catch (error) {
      return malformedOutput("claude", null, error);
    }
  },
};
