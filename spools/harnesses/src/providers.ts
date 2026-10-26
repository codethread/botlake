import { fileURLToPath } from "node:url";

import { z } from "zod";

export interface ProviderRun {
  provider: string;
  cwd: string;
  prompt: string;
  model?: string | undefined;
  effort?: string | undefined;
  fast?: boolean | undefined;
  sessionId: string;
  resumes: boolean;
  extraArgs: string[];
  systemPrompts: string[];
}
export interface LaunchPlan {
  command: string[];
  stdin: string;
  env: Record<string, string>;
}
export interface Outcome {
  success: boolean;
  result: string | null;
  sessionId: string | null;
  error: string | null;
}
export interface Provider {
  name: "codex" | "pi" | "claude" | "cursor";
  prepare(run: ProviderRun): LaunchPlan;
  finish(run: ProviderRun, exitCode: number, stdout: string, stderr: string): Outcome;
}
function jsonLines(stdout: string): { events: Record<string, unknown>[]; error: string | null } {
  const events: Record<string, unknown>[] = [];
  for (const line of stdout.split("\n").filter((value) => value.trim().length > 0)) {
    try {
      events.push(z.record(z.string(), z.unknown()).parse(JSON.parse(line)));
    } catch (error) {
      return { events, error: `Truncated or malformed JSONL: ${String(error)}` };
    }
  }
  return { events, error: null };
}
function nativeSession(
  events: Record<string, unknown>[],
  type: string,
  key: string,
): string | null {
  for (const event of events) {
    const id = event[key];
    if (event["type"] === type && typeof id === "string" && id.trim().length > 0) return id;
  }
  return null;
}
function result(success: boolean, value: unknown, session: unknown, error: string | null): Outcome {
  const message = typeof value === "string" && value.trim().length > 0 ? value : null;
  const id = typeof session === "string" && session.trim().length > 0 ? session : null;
  return {
    success: success && message !== null && id !== null,
    result: message,
    sessionId: id,
    error:
      error ??
      (message === null
        ? "Provider returned no result"
        : id === null
          ? "Provider returned no native session"
          : null),
  };
}
function finish(
  name: Provider["name"],
  run: ProviderRun,
  exitCode: number,
  stdout: string,
  stderr: string,
): Outcome {
  // Resume ids already name proven history; Pi/Claude pin new ids on clean exits.
  let sessionId =
    run.resumes || ((name === "pi" || name === "claude") && exitCode === 0) ? run.sessionId : null;
  try {
    if (name === "claude" || name === "cursor") {
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
        observed ? envelope.session_id : sessionId,
        exitCode !== 0 || envelope.is_error === true
          ? stderr.length > 0
            ? stderr
            : "Provider failed"
          : observed
            ? null
            : "Provider returned no session id",
      );
    }
    const decoded = jsonLines(stdout);
    const { events } = decoded;
    if (name === "codex") {
      const observed = nativeSession(events, "thread.started", "thread_id");
      sessionId = observed ?? sessionId;
      const messages = events
        .filter((event) => event["type"] === "item.completed")
        .map((event) =>
          z.object({ type: z.string(), text: z.string().optional() }).parse(event["item"]),
        )
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
    }
    const observed = nativeSession(events, "session", "id");
    sessionId = observed ?? sessionId;
    const messages = events.flatMap((event) => {
      const role = z.object({ role: z.string() }).safeParse(event["message"]);
      if (!role.success || role.data.role !== "assistant") return [];
      return [
        {
          type: event["type"],
          message: z
            .object({
              content: z
                .array(z.object({ type: z.string(), text: z.string().optional() }))
                .optional(),
              stopReason: z.string().optional(),
              errorMessage: z.unknown().optional(),
            })
            .parse(event["message"]),
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
    return {
      success: false,
      result: null,
      sessionId,
      error: `Malformed ${name} output: ${String(error)}`,
    };
  }
}
export function provider(name: Provider["name"]): Provider {
  return {
    name,
    prepare(run) {
      if (name === "cursor") {
        return {
          command: [
            "agent",
            "--print",
            "--output-format",
            "json",
            ...(run.resumes ? ["--resume", run.sessionId] : []),
            ...(run.model === undefined
              ? []
              : [
                  "--model",
                  `${run.model}${run.effort === undefined ? "" : `-${run.effort}`}${run.fast === true ? "-fast" : ""}`,
                ]),
            "--plugin-dir",
            fileURLToPath(new URL("../plugins/cursor/", import.meta.url)),
            ...run.extraArgs,
          ],
          stdin: `${run.prompt}\n`,
          env: { MILLSTRAND_HARNESS_CURSOR_SYS_PROMPT: run.systemPrompts.join("\n\n") },
        };
      }
      const options = [...run.extraArgs];
      if (run.model !== undefined) options.push("--model", run.model);
      if (run.effort !== undefined)
        options.push(
          name === "codex" ? "--config" : name === "pi" ? "--thinking" : "--effort",
          name === "codex" ? `model_reasoning_effort=${JSON.stringify(run.effort)}` : run.effort,
        );
      if (name === "codex" && run.systemPrompts.length > 0)
        options.push(
          "--config",
          `developer_instructions=${JSON.stringify(run.systemPrompts.join("\n\n"))}`,
        );
      if (name === "pi" || name === "claude")
        for (const prompt of run.systemPrompts) options.push("--append-system-prompt", prompt);
      let command: string[];
      switch (name) {
        case "codex":
          command = [
            "codex",
            "exec",
            ...(run.resumes ? ["resume"] : []),
            "--json",
            ...options,
            ...(run.resumes ? [run.sessionId, "-"] : []),
          ];
          break;
        case "pi":
          command = [
            "pi",
            "--print",
            "--mode",
            "json",
            ...options,
            run.resumes ? "--session" : "--session-id",
            run.sessionId,
          ];
          break;
        case "claude":
          command = [
            "claude",
            "--print",
            "--output-format",
            "json",
            ...options,
            run.resumes ? "--resume" : "--session-id",
            run.sessionId,
          ];
          break;
      }
      return {
        command,
        stdin: `${run.prompt}\n`,
        env: {},
      };
    },
    finish: (run, exitCode, stdout, stderr) => finish(name, run, exitCode, stdout, stderr),
  };
}
