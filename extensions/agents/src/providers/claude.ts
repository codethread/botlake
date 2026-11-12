import { z } from "zod";

import { providerCommand, type BuiltinProviderOptions, type Provider } from "./contract.ts";
import { malformedOutput, result } from "./output.ts";

const envelopeSchema = z.compile(
  z.object({
    session_id: z.string().optional(),
    result: z.string().optional(),
    is_error: z.boolean().optional(),
  }),
);

export function claude(options: BuiltinProviderOptions = {}): Provider {
  const command = providerCommand("claude", options);
  return {
    name: "claude",
    ...(options.flag === undefined ? {} : { flag: options.flag }),
    doc: "Claude Code CLI. Uses the provider's default model unless an alias selects one.",

    prepare(run) {
      const args = [...run.extraArgs];
      if (run.model !== undefined) args.push("--model", run.model);
      if (run.effort !== undefined) args.push("--effort", run.effort);
      if (run.systemPrompt.length > 0) args.push("--append-system-prompt", run.systemPrompt);

      return {
        command: [
          ...command,
          "--print",
          "--output-format",
          "json",
          ...args,
          ...(run.resumes ? ["--resume", run.sessionId] : []),
        ],
        stdin: `${run.prompt}\n`,
        env: {},
      };
    },

    finish(_run, exitCode, stdout, stderr) {
      // Report evidence from this invocation, never the requested resume id.
      try {
        const envelope = envelopeSchema.parse(JSON.parse(stdout));
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
}
