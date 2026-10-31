import type { NativeObservation, ProviderName } from "@botlake/native-session";

import type { SessionReport } from "../session.ts";
import type { NativeHookInput } from "./events.ts";

export interface HookEvent {
  /** Parsed native identity, activity and metadata. */
  observation: NativeObservation;
  /** Whether this event is independent of an inherited managed run. */
  unmanaged: boolean;
  /** Whether the host accepts context on this event. */
  context: boolean;
  /** Host event name used in its response protocol. */
  nativeEvent: string;
}

export interface HookAdapter {
  /** Native host whose wire protocol this adapter translates. */
  provider: ProviderName;
  /** Translate a parsed root-session hook into an observation. */
  decode(input: NativeHookInput): HookEvent;
  /** Deliver context through the host-specific transport. */
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
