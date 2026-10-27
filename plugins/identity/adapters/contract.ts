import type { NativeObservation, ProviderName } from "@botlake/native-session";

import type { SessionReport } from "../session.ts";

export interface HookEvent {
  observation: NativeObservation;
  unmanaged: boolean;
  context: boolean;
  nativeEvent: string;
}

export interface HookAdapter {
  provider: ProviderName;
  decode(raw: unknown): HookEvent;
  deliver(event: HookEvent, report: SessionReport, env: NodeJS.ProcessEnv): Promise<unknown>;
}

export function contextOutput(event: HookEvent, report: SessionReport): unknown {
  return event.context
    ? {
        hookSpecificOutput: {
          hookEventName: event.nativeEvent,
          additionalContext: [report.instruction, report.systemPrompt]
            .filter((part) => part.length > 0)
            .join("\n\n"),
        },
        ...(report.error === undefined ? {} : { systemMessage: report.error }),
      }
    : {};
}
