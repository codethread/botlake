/** Native identity node attribute keys. */
export const identityAttributes = {
  /** Identity credited on a domain record, independently of current assignment. */
  byIdentity: "identity/by-identity",
  /** Marks a native-session identity record. */
  session: "identity/session",
  /** Deterministic identity name derived from provider and native session. */
  id: "identity/id",
  /** Native provider name. */
  provider: "identity/provider",
  /** Provider-scoped native session identifier. */
  nativeSessionId: "identity/native-session-id",
  /** Last reported lifecycle activity; not process liveness. */
  activity: "identity/activity",
  /** Selected agent seat, when reported. */
  agentSeat: "identity/agent-seat",
  /** Selected model, when reported. */
  model: "identity/model",
  /** Selected thinking level or effort, when reported. */
  thinkingLevel: "identity/thinking-level",
  /** Last observed native event. */
  lastEvent: "identity/last-event",
  /** Clock time of the last observation. */
  observedAt: "identity/observed-at",
  /** Working directory reported by the observation. */
  cwd: "identity/cwd",
  /** Adapter-specific native event name, when supplied. */
  nativeEvent: "identity/native-event",
  /** Native session transcript path, when supplied. */
  sessionPath: "identity/session-path",
  /** Native capabilities reported by the adapter. */
  capabilities: "identity/capabilities",
} as const;

/** Identity provenance and native-lineage edge labels. */
export const identityRelations = {
  /** Parent native session to spawned session. */
  spawned: "spawned",
  /** Identity to a managed invocation or external session run it participated in. */
  performed: "performed",
  /** Identity credited for a node or record. */
  attributed: "attributed",
  /** Identity that reported a node or record. */
  reported: "reported",
  /** Identity that claimed a node or record. */
  claimed: "claimed",
} as const;

/** Relations accepted by the attribution API. */
export type AttributionRelation =
  | typeof identityRelations.attributed
  | typeof identityRelations.reported
  | typeof identityRelations.claimed;
