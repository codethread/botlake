import { activitySchema, runUsageSchema } from "@botlake/native-session";
import { z } from "zod";

/** Agents owns run records and process evidence, independently of Work assignment. */
export const agentAttributes = {
  /** Marks a tracked managed invocation or observed external session. */
  run: "agent/run",
  /** Authoritative managed-run XState state; external sessions have no custody lifecycle. */
  lifecycle: "agent/lifecycle",
  /** Current invocation's run-activity handle; earlier handles remain linked to this run. */
  activity: "agent/activity",
  /** Indexed display projection of the lifecycle, or external. */
  state: "agent/state",
  /** Derived lifecycle/result classification. */
  substatus: "agent/substatus",
  /** Request admission has completed. */
  accepted: "agent/accepted",
  /** Indexed lifecycle projection: custody has settled, independently of success. */
  settled: "agent/settled",
  /** Number of launch attempts. */
  attempt: "agent/attempt",
  /** Provider implementing execution and native observation. */
  provider: "agent/provider",
  /** Intended recipient: human, agent or unknown. */
  audience: "agent/audience",
  /** Selected named model seat. */
  seat: "agent/seat",
  /** Resolved working directory. */
  cwd: "agent/cwd",
  /** Accepted user-visible instructions. */
  prompt: "agent/prompt",
  /** Task completion guidance supplied to the worker. */
  policy: "agent/policy",
  /** Caller-provided contextual attributes. */
  context: "agent/context",
  /** Frozen resolved seat/provider settings. */
  settings: "agent/settings",
  /** Idempotency key for run admission. */
  requestId: "agent/request-id",
  /** Canonical request fingerprint. */
  requestHash: "agent/request-hash",
  /** Current attempt's generation, used to fence native callbacks. */
  invocation: "agent/invocation",
  /** Frozen process launch specification. */
  launch: "agent/launch",
  /** Supervisor-owned process handle. */
  handle: "agent/handle",
  /** Last observed process-custody evidence. */
  custody: "agent/custody",
  /** Latest provider result. */
  result: "agent/result",
  /** Latest execution or integration failure. */
  error: "agent/error",
  /** This run resumes a verified native session. */
  resumes: "agent/resumes",
  /** Host-native session identifier. */
  sessionId: "agent/session-id",
  /** Native session evidence has been verified. */
  sessionConfirmed: "agent/session-confirmed",
  /** Registered attribution identity, once available. */
  identity: "agent/identity",
  /** Session evidence source: unobserved, native or output. */
  integration: "agent/integration",
  /** Latest reported session activity and metadata. */
  observation: "agent/observation",
  /** An external session is observed without process custody. */
  external: "agent/external",
  /** Retained process evidence has been acknowledged. */
  acknowledged: "agent/acknowledged",
} as const;

export const agentRelations = {
  /** Run to its task; admission guidance, not the Work assignment ledger. */
  serves: "serves",
  /** Resumed run to the earlier run whose native session it continues. */
  continues: "continues",
} as const;

export const runActivityAttributes = {
  /** Stable handle for a SQL-backed stream, retained after event expiry. */
  stream: "run-activity/stream",
};

export const runActivityRelations = {
  /** Activity handle to the managed invocation or external run it records. */
  run: "records-run",
  /** Activity handle to the native identity it observed. */
  identity: "records-identity",
} as const;

export const runActivityOptionsSchema = z.compile(
  z.strictObject({
    retentionMs: z
      .number()
      .int()
      .positive()
      .default(7 * 24 * 60 * 60 * 1000),
  }),
);

/** SQL header and eventual tombstone; event payloads never live in graph attributes. */
export const runActivityStreamSchema = z.compile(
  z.object({
    id: z.string(),
    run: z.string(),
    invocation: z.string().nullable(),
    identity: z.string().nullable(),
    provider: z.string(),
    sessionId: z.string().nullable(),
    sessionPath: z.string().nullable(),
    capabilities: z.string().transform((value) => z.array(z.string()).parse(JSON.parse(value))),
    startedAt: z.number(),
    lastObservedAt: z.number().nullable(),
    endedAt: z.number().nullable(),
    expiresAt: z.number().nullable(),
    expiredAt: z.number().nullable(),
    eventCount: z.number(),
  }),
);

export const runActivityEventSchema = z.compile(
  z.object({
    sequence: z.number(),
    activity: z.string(),
    at: z.number(),
    kind: z.enum([
      "session-started",
      "session-ended",
      "turn-started",
      "turn-ended",
      "tool-started",
      "tool-ended",
      "message",
      "usage",
    ]),
    turnId: z.string().nullable(),
    callId: z.string().nullable(),
    tool: z.string().nullable(),
    role: z.string().nullable(),
    summary: z.string(),
    outcome: z.string().nullable(),
    truncated: z.number().transform((value) => value === 1),
    usage: z
      .string()
      .transform((value) => runUsageSchema.parse(JSON.parse(value)))
      .nullable(),
  }),
);

export const agentRunStateSchema = z.compile(
  z.enum(["ready", "running", "stopped", "failed", "external"]),
);

export const agentLifecycleSchema = z.compile(
  z.enum([
    "pending",
    "running",
    "awaitingExit",
    "reconciling",
    "completed",
    "cancelled",
    "abandoned",
    "launchFailed",
    "executionFailed",
    "sessionFailed",
    "preparationFailed",
  ]),
);

const text = z.string().min(1);
export const agentLaunchSchema = z.compile(
  z.strictObject({
    owner: text,
    key: text,
    command: z.array(text).min(1),
    cwd: text,
    env: z.record(z.string(), z.string()),
    stdin: z.string(),
  }),
);

/** Activity evidence needed for liveness inspection; other native metadata is retained on the run. */
export const agentActivityObservationSchema = z.compile(
  z.object({ at: z.number().int(), activity: activitySchema }),
);
