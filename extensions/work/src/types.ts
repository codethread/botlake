import type { Json, Reference } from "@botlake/core";

export type JsonObject = Record<string, Json>;

import type { WorkLinkRelation } from "./node-model.ts";

export interface Attribution {
  /** Identity responsible for the recorded change. */
  by: string;
  /** ISO timestamp from the lake clock. */
  at: string;
}

export interface CriterionChange extends Attribution {
  /** Explicit resolution or correction that restores an open condition. */
  kind: "resolved" | "reopened";
  /** Assessment, correction, or reason the condition is no longer needed. */
  text: string;
}

export type Criterion = {
  /** Stable identity within the task. */
  id: string;
  /** Original condition, never rewritten or removed. */
  condition: string;
} & (
  | { state: "open"; resolution: null }
  | { state: "resolved"; resolution: Attribution & { text: string } }
);

export interface Assignment extends Attribution {
  /** Generation used to fence delayed release and heartbeat observations. */
  id: string;
  /** Responsible participant; assignment is not execution evidence. */
  assignee: string;
  /** Retained release attribution; null while this assignment is current. */
  release: (Attribution & { reason: string }) | null;
}

export interface ItemBase {
  /** Stable graph identity. */
  id: string;
  /** Short label for work or context. */
  title: string;
  /** Local brief; group briefs are inherited through context reads. */
  description: string;
  /** Outstanding or settled, independently of readiness or outcome. */
  state: "open" | "closed";
  /** Optimistic concurrency token for editing the brief. */
  revision: number;
  /** Most recent closure actor, null while open. */
  closedBy: string | null;
  /** Most recent closure time, null while open. */
  closedAt: string | null;
}

export interface Task extends ItemBase {
  /** Actionable leaf work. */
  kind: "task";
  /** Conclusions, findings and references, not a transcript. */
  notes: string | null;
  /** Preserved conditions and their current assessments. */
  acceptanceCriteria: Criterion[];
  /** Current responsible identity, or none. */
  assignee: string | null;
  /** Current reservation and its fencing token. */
  assignment: Assignment | null;
  /** Participation mode; not an approval verdict. */
  audience: "AFK" | "HITL";
  /** Expected work versus an interruption, independently of urgency. */
  origin: "planned" | "unplanned";
  /** P0 is immediate attention; P4 is lowest urgency. */
  priority: "P0" | "P1" | "P2" | "P3" | "P4";
}

export interface Group extends ItemBase {
  /** Non-assignable context containing groups and tasks. */
  kind: "group";
}

export interface GatePolicy {
  everyMs: number;
  maxAttempts: number;
  timeoutMs: number;
}

export interface GateAttempt {
  at: string;
  outcome: "failed" | "errored";
  message: string;
  evidence?: JsonObject | undefined;
}

export type GateStatus =
  | { status: "pending"; round: number }
  | { status: "waiting"; round: number; attempts: number; last: GateAttempt; nextAt: string }
  | { status: "exhausted"; round: number; attempts: number; last: GateAttempt }
  | {
      status: "cleared";
      at: string;
      by: string;
      via: "probe" | "actor";
      message: string;
      evidence?: JsonObject | undefined;
    }
  | { status: "dismissed"; at: string; by: string; reason: string };

export type GateCommand =
  | {
      type: "attempt";
      round: number;
      attempt: number;
      at: string;
      by: string;
      result:
        | { outcome: "passed"; message: string; evidence?: JsonObject | undefined }
        | GateAttempt;
    }
  | { type: "retry"; at: string; by: string; reason: string }
  | { type: "clear"; at: string; by: string; message: string }
  | { type: "dismiss"; at: string; by: string; reason: string };

export type GateTransition =
  | { kind: "moved"; from: GateStatus; to: GateStatus }
  | { kind: "refused"; code: "closed" | "stale"; message: string };

export interface Gate extends ItemBase {
  kind: "gate";
  probe: string;
  params: JsonObject;
  policy: GatePolicy;
  status: GateStatus;
}

export type WorkItem = Task | Group | Gate;

interface CreateBase {
  /** Short label for work or context. */
  title: string;
  /** Optional local brief. */
  description?: string | undefined;
  /** Contextual home; only a group may be a parent. */
  parent?: string | undefined;
  /** Direct prerequisite task/group identities. */
  prerequisites?: string[] | undefined;
  /** Attribution defaults to the invocation caller. */
  by?: string | undefined;
}

export type CreateItem = CreateBase &
  (
    | { kind: "group" }
    | {
        kind: "task";
        notes?: string | undefined;
        acceptanceCriteria?: string[] | undefined;
        assignee?: string | undefined;
        audience?: Task["audience"] | undefined;
        origin?: Task["origin"] | undefined;
        priority?: Task["priority"] | undefined;
      }
  );

export interface UpdateItem {
  title?: string | undefined;
  description?: string | undefined;
  notes?: string | undefined;
  audience?: Task["audience"] | undefined;
  origin?: Task["origin"] | undefined;
  priority?: Task["priority"] | undefined;
  expectedRevision?: number | undefined;
}

interface SummaryBase {
  id: string;
  title: string;
  state: "open" | "closed";
  ready: boolean;
  assignee: string | null;
  audience: Task["audience"] | null;
  origin: Task["origin"] | null;
  priority: Task["priority"] | null;
  parent: string | null;
}

export type WorkSummary = SummaryBase &
  (
    | {
        kind: "task" | "group" | "gate";
        gate: Pick<Gate, "probe" | "status"> | null;
      }
    | {
        /** Observed endpoint owned by another lake, never locally actionable. */
        kind: "reference";
        /** Source identity, revision and current observation availability. */
        reference: Reference;
      }
  );

export interface ListOptions {
  view?: "all" | "ready" | "available" | "assigned" | "waiting" | "human" | undefined;
  state?: "open" | "closed" | "all" | undefined;
  kind?: "task" | "group" | "gate" | undefined;
  assignee?: string | undefined;
  origin?: Task["origin"] | undefined;
  audience?: Task["audience"] | undefined;
  search?: string | undefined;
  parent?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export interface Page<T> {
  items: T[];
  total: number;
  nextOffset: number | null;
}

export interface WorkTopologyOptions {
  /** Optional work item anchoring the projection. */
  id?: string | undefined;
  /** Included lifecycle state; defaults to open. */
  state?: "open" | "closed" | "all" | undefined;
  /** Return only identity, title, and state when true. */
  lean?: boolean | undefined;
  /** Include local descriptions on non-lean nodes. */
  showDescription?: boolean | undefined;
  /** Include task acceptance criteria on non-lean nodes. */
  showCriteria?: boolean | undefined;
}

export interface WorkTreeOptions extends WorkTopologyOptions {}

export interface WorkGraphOptions extends WorkTopologyOptions {
  /** Relationship traversal from the root; requires id. */
  direction?: "prerequisites" | "dependents" | undefined;
}

export type WorkTopologyNode =
  | Pick<WorkSummary, "id" | "title" | "state">
  | (Pick<WorkSummary, "id" | "title" | "state"> & {
      /** Remote endpoint marker retained even in lean graph output. */
      kind: "reference";
      /** Provenance and freshness of the observed endpoint. */
      reference: Reference;
    })
  | (WorkSummary & {
      description?: string | undefined;
      acceptanceCriteria?: Criterion[] | undefined;
    });

export interface WorkTopology {
  /** Projection kind. */
  view: "tree" | "graph";
  /** Explicit projection root, or null for a forest. */
  root: string | null;
  /** Visible entry points in deterministic order. */
  roots: string[];
  /** Edge traversal or containment direction. */
  direction: "children" | "prerequisites" | "dependents";
  /** Visible work items in deterministic order. */
  nodes: WorkTopologyNode[];
  /** Visible canonical relationships. */
  edges: { from: string; to: string; relation: "parent-of" | "depends-on" }[];
  /** Nonmatching ancestors retained to connect a tree. */
  context: string[];
  /** Weak graph components or tree containment families. */
  components: string[][];
  /** Scoped relationships crossing the visible projection. */
  omittedLinks: number;
}

export interface AbandonmentResult {
  /** Original terminal attribution, retained unchanged on retries. */
  abandonment: Attribution & { reason: string };
  /** Requested work item after terminal closure. */
  item: WorkItem;
  /** Open tasks closed without resolving their criteria. */
  tasks: string[];
  /** Open gates terminally dismissed. */
  gates: string[];
  /** Open groups closed after their descendants. */
  groups: string[];
}

export interface WorkDetail {
  item: WorkItem;
  context: Group[];
  prerequisites: WorkSummary[];
  references: WorkSummary[];
  members: Page<WorkSummary>;
  ready: boolean;
  history?:
    | {
        assignments: Assignment[];
        criteria: { id: string; changes: CriterionChange[] }[];
        closures: Attribution[];
        reopenings: (Attribution & { reason: string })[];
        abandonments: (Attribution & { reason: string })[];
      }
    | undefined;
}

export interface WorkStore {
  create(input: CreateItem): WorkItem;
  get(id: string): WorkItem;
  update(id: string, input: UpdateItem): WorkItem;
  inspect(id: string, options?: { history?: boolean; limit?: number; offset?: number }): WorkDetail;
  summary(id: string): WorkSummary;
  list(options?: ListOptions): Page<WorkSummary>;
  tree(options?: WorkTreeOptions): WorkTopology;
  graph(options?: WorkGraphOptions): WorkTopology;
  close(id: string, by?: string): WorkItem;
  abandon(id: string, reason: string, by?: string): AbandonmentResult;
  gates: {
    create(input: {
      title: string;
      description?: string;
      parent?: string;
      probe: string;
      params: JsonObject;
      policy: GatePolicy;
      dependents?: string[];
      by: string;
    }): Gate;
    apply(id: string, command: GateCommand): GateTransition;
    get(id: string): Gate;
  };
  reopen(id: string, reason: string, by?: string): WorkItem;
  addCriterion(id: string, condition: string, by?: string): Criterion;
  resolveCriterion(
    id: string,
    criterion: string,
    text: string,
    by?: string,
    correct?: boolean,
  ): Criterion;
  reopenCriterion(id: string, criterion: string, reason: string, by?: string): Criterion;
  claim(id: string, assignee?: string, by?: string): Assignment;
  release(id: string, assignmentId: string, reason: string, by?: string): boolean;
  move(id: string, parent: string | null): void;
  link(from: string, to: string, relation: WorkLinkRelation): void;
  unlink(from: string, to: string, relation: WorkLinkRelation): void;
}
