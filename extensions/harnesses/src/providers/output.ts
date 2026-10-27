import { z } from "zod";

import type { Outcome, ProviderName } from "./contract.ts";

export function jsonLines(stdout: string): {
  events: Record<string, unknown>[];
  error: string | null;
} {
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

export function nativeSession(
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

export function result(
  success: boolean,
  value: unknown,
  session: unknown,
  error: string | null,
): Outcome {
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

export function malformedOutput(
  name: ProviderName,
  sessionId: string | null,
  error: unknown,
): Outcome {
  return {
    success: false,
    result: null,
    sessionId,
    error: `Malformed ${name} output: ${String(error)}`,
  };
}
