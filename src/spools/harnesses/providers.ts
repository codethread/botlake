import { fileURLToPath } from "node:url";

import { z } from "zod";

export interface ProviderRun {
  provider: string;
  cwd: string;
  prompt: string;
  model?: string | undefined;
  effort?: string | undefined;
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
function jsonLines(stdout: string): Record<string, unknown>[] {
  return stdout
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => z.record(z.string(), z.unknown()).parse(JSON.parse(line)));
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
  try {
    if (name === "claude" || name === "cursor") {
      const envelope = z
        .object({ session_id: z.string(), result: z.string(), is_error: z.boolean().optional() })
        .parse(JSON.parse(stdout));
      return result(
        exitCode === 0 && envelope.is_error !== true,
        envelope.result,
        envelope.session_id,
        exitCode !== 0 || envelope.is_error === true
          ? stderr.length > 0
            ? stderr
            : "Provider failed"
          : null,
      );
    }
    const events = jsonLines(stdout);
    if (name === "codex") {
      const started = events.find((event) => event["type"] === "thread.started");
      const messages = events
        .filter((event) => event["type"] === "item.completed")
        .map((event) =>
          z.object({ type: z.string(), text: z.string().optional() }).parse(event["item"]),
        )
        .filter((item) => item.type === "agent_message");
      const failure = events.find(
        (event) => event["type"] === "turn.failed" || event["type"] === "error",
      );
      const completed = events.some((event) => event["type"] === "turn.completed");
      return result(
        exitCode === 0 && failure === undefined && completed,
        messages.at(-1)?.text,
        started?.["thread_id"],
        exitCode !== 0
          ? stderr.length > 0
            ? stderr
            : `Codex exited ${exitCode}`
          : failure !== undefined
            ? JSON.stringify(failure)
            : !completed
              ? "Codex stream ended before turn completion"
              : null,
      );
    }
    const session = events.find((event) => event["type"] === "session");
    const messages = events
      .filter((event) => event["type"] === "message_end")
      .map((event) =>
        z
          .object({
            role: z.string(),
            content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
            stopReason: z.string().optional(),
            errorMessage: z.string().optional(),
          })
          .parse(event["message"]),
      )
      .filter((message) => message.role === "assistant");
    const last = messages.at(-1);
    const failed = last?.stopReason === "error" || last?.stopReason === "aborted";
    const completed = events.some((event) => event["type"] === "agent_end");
    return result(
      exitCode === 0 && !failed && completed,
      last?.content
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("\n"),
      session?.["id"] ?? (exitCode === 0 ? run.sessionId : null),
      exitCode !== 0
        ? stderr.length > 0
          ? stderr
          : `Pi exited ${exitCode}`
        : failed
          ? (last.errorMessage ?? "Pi assistant failed")
          : !completed
            ? "Pi stream ended before agent completion"
            : null,
    );
  } catch (error) {
    return {
      success: false,
      result: null,
      sessionId: null,
      error: `Malformed ${name} output: ${String(error)}`,
    };
  }
}
export function provider(name: Provider["name"]): Provider {
  return {
    name,
    prepare(run) {
      const options = [...run.extraArgs];
      if (run.model !== undefined)
        options.push(
          "--model",
          name === "cursor" && run.effort !== undefined ? `${run.model}-${run.effort}` : run.model,
        );
      if (run.effort !== undefined && name !== "cursor")
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
        case "cursor":
          command = [
            "agent",
            "--print",
            "--output-format",
            "json",
            "--plugin-dir",
            fileURLToPath(new URL("../../../plugins/cursor/harness", import.meta.url)),
            ...options,
            ...(run.resumes ? ["--resume", run.sessionId] : []),
          ];
          break;
      }
      return {
        command,
        stdin: `${run.prompt}\n`,
        env:
          name === "cursor"
            ? { MILLSTRAND_HARNESS_CURSOR_SYS_PROMPT: run.systemPrompts.join("\n\n") }
            : {},
      };
    },
    finish: (run, exitCode, stdout, stderr) => finish(name, run, exitCode, stdout, stderr),
  };
}
