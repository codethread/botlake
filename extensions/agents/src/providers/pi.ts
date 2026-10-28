import { z } from "zod";

import type { Provider } from "./contract.ts";
import { jsonLines, malformedOutput, nativeSession, result } from "./output.ts";

const roleSchema = z.compile(z.object({ role: z.string() }));
const messageSchema = z.compile(
  z.object({
    content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
    stopReason: z.string().optional(),
    errorMessage: z.unknown().optional(),
  }),
);

export const pi: Provider = {
  name: "pi",
  doc: "Pi CLI. Model names may include a provider prefix, such as openai-codex/.",

  prepare(run) {
    const options = [...run.extraArgs];
    if (run.model !== undefined) options.push("--model", run.model);
    if (run.effort !== undefined) options.push("--thinking", run.effort);
    if (run.systemPrompt.length > 0) options.push("--append-system-prompt", run.systemPrompt);

    return {
      command: [
        "pi",
        "--print",
        "--mode",
        "json",
        ...options,
        ...(run.resumes ? ["--session", run.sessionId] : []),
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
      const observed = nativeSession(events, "session", "id");
      sessionId = observed;

      const messages = events.flatMap((event) => {
        const role = roleSchema.safeParse(event["message"]);
        if (!role.success || role.data.role !== "assistant") return [];

        return [
          {
            type: event["type"],
            message: messageSchema.parse(event["message"]),
          },
        ];
      });
      const last = messages.at(-1)?.message;
      const failed = last?.stopReason === "error" || last?.stopReason === "aborted";

      const texts = messages
        .filter((event) => event.type === "message_end")
        .map(
          ({ message }) =>
            message.content
              ?.filter(
                (part) =>
                  part.type === "text" &&
                  typeof part.text === "string" &&
                  part.text.trim().length > 0,
              )
              .map((part) => part.text)
              .join("\n\n") ?? "",
        );

      const success = exitCode === 0 && !failed && decoded.error === null && observed !== null;

      return result(
        success,
        success ? texts.at(-1) : texts.findLast((value) => value.length > 0),
        sessionId,
        exitCode !== 0
          ? stderr.length > 0
            ? stderr
            : `Pi exited ${exitCode}`
          : failed
            ? typeof last.errorMessage === "string"
              ? last.errorMessage
              : (JSON.stringify(last.errorMessage) ?? "Pi assistant failed")
            : (decoded.error ?? (observed === null ? "Pi returned no session id" : null)),
      );
    } catch (error) {
      return malformedOutput("pi", sessionId, error);
    }
  },
};
