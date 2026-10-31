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

export type WorkItem = Task | Group;

interface CreateBase {
  /** Short label for work or context. */
  title: string;
  /** Optional local brief. */
  description?: string | undefined;
  /** Contextual home; only a group may be a parent. */
  parent?: string | undefined;
  /** Direct prerequisite task/group identities. */
  prerequisites?: string[] | undefined;
  /** Attribution defaults to the caller's BL_ACTOR. */
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

export interface WorkSummary {
  id: string;
  kind: "task" | "group";
  title: string;
  state: "open" | "closed";
  ready: boolean;
  assignee: string | null;
  audience: Task["audience"] | null;
  origin: Task["origin"] | null;
  priority: Task["priority"] | null;
  parent: string | null;
}

export interface ListOptions {
  view?: "all" | "ready" | "available" | "assigned" | "waiting" | "human" | undefined;
  state?: "open" | "closed" | "all" | undefined;
  kind?: "task" | "group" | undefined;
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
  close(id: string, by?: string): WorkItem;
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
