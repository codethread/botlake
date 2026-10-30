import {
  jsonSchema,
  encode,
  Fault,
  requireValue,
  nodeSchema,
  defineOp,
  q,
  type Attributes,
  type Json,
  type Node,
  type Context,
  type Extension,
} from "@botlake/core";
import { attribute, attribution, callerActor } from "@botlake/extension-identity";
import { match } from "ts-pattern";
import { z } from "zod";

import { KanbanBlockages, blockageCommands } from "./blockages.ts";
import {
  policyApplies,
  progressionSchema,
  protectProgression,
  unresolvedDescendants,
} from "./progression.ts";

const text = z.compile(z.string().trim().min(1));
const stringArray = z.compile(z.array(z.string()));

const lane = z.compile(
  z.enum(["refinement", "pending", "claimed", "blocked", "in_review", "in_production"]),
);

const priority = z.compile(z.enum(["p1", "p2", "p3", "p4"]));

const pendingFeaturePredicate = q.and(
  q.eq(q.attr("kanban/card"), true),
  q.eq(q.attr("kanban/type"), "feature"),
  q.eq(q.attr("kanban/lane"), "pending"),
  q.missing(q.attr("kanban/link")),
);

const referenceSchema = z.compile(
  z.strictObject({
    url: z.url({ protocol: /^https?$/u }),
    label: z.string().optional(),
  }),
);
const refsSchema = z.compile(
  z.array(referenceSchema).superRefine((refs, ctx) => {
    if (new Set(refs.map((ref) => ref.url)).size !== refs.length)
      ctx.addIssue({ code: "custom", message: "Duplicate reference URL" });
  }),
);

const linkSchema = z.compile(z.strictObject({ workspace: text, card: text }));

const claimInput = z.compile(
  z.strictObject({
    id: text,
    owner: text.optional(),
    branch: text.optional(),
    worktree: text.optional(),
    runId: text.optional(),
    byIdentity: text.optional(),
  }),
);

const pageInput = {
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).default(0),
};

const workFields = {
  body: z.string().optional(),
  acceptance: z.string().optional(),
  summary: z.string().optional(),
};

const updateInput = z.compile(
  z.strictObject({
    id: text,
    title: text.optional(),
    ...workFields,
    lane: lane.exclude(["claimed", "blocked"]).optional(),
    progression: progressionSchema.optional(),
    expectedRevision: z.number().int().positive().optional(),
  }),
);

const addInput = z.compile(
  z.strictObject({
    title: text,
    type: z.enum(["feature", "epic"]).default("feature"),
    lane: z.enum(["pending", "refinement"]).default("pending"),
    priority: priority.default("p3"),
    ...workFields,
    epic: text.optional(),
    progression: progressionSchema.optional(),
    byIdentity: text.optional(),
    reportedBy: text.optional(),
    labels: z.array(text).optional(),
  }),
);

const taskInput = z.compile(
  z.strictObject({
    feature: text,
    title: text,
    ...workFields,
    dependencies: z.array(text).default([]),
    byIdentity: text.optional(),
  }),
);

const exportInput = z.compile(z.strictObject({ id: text }));
const idResponse = z.compile(z.object({ id: text }));
const cardView = z.compile(z.object({ card: nodeSchema, owner: jsonSchema }));
const mirrorResponse = z.compile(
  z.object({
    card: z.object({
      id: text,
      title: text,
      state: nodeSchema.shape.state,
      attributes: z.record(z.string(), jsonSchema),
    }),
    owner: jsonSchema,
  }),
);

export class Kanban {
  private readonly authority = Symbol("kanban");

  constructor(
    private readonly ctx: Context,
    private readonly blockages: KanbanBlockages = new KanbanBlockages(ctx),
  ) {
    ctx.graph.protect((changes, token) => {
      for (const change of changes) {
        if (change.kind === "node") {
          const before = change.before;
          const after = change.after;
          if (before?.attributes["kanban/ownership-claim"] === true)
            throw new Fault("ownership", "Ownership claims are immutable source records");
          if (after?.attributes["kanban/ownership-claim"] === true && token !== this.authority)
            throw new Fault("ownership", "Claims require the Kanban API");
          if (
            token !== this.authority &&
            before !== null &&
            after !== null &&
            encode(before.attributes["kanban/external-refs"] ?? null) !==
              encode(after.attributes["kanban/external-refs"] ?? null) &&
            change.expectedRevision !== before.revision
          )
            throw new Fault("stale", "Reference writes require expectedRevision");
          if (
            token !== this.authority &&
            before?.state === "active" &&
            after?.state === "closed" &&
            (before.attributes["kanban/card"] === true ||
              before.attributes["kanban/task"] === true) &&
            before.attributes["kanban/link"] === undefined &&
            this.unfinished(before.id).length > 0
          )
            throw new Fault("finish", "Finish child work first; use Kanban for abandonment");
          if (after?.attributes["kanban/progression"] !== undefined)
            progressionSchema.parse(after.attributes["kanban/progression"]);
          if (after?.attributes["kanban/card"] === true) {
            const refs = after.attributes["kanban/external-refs"];
            if (refs !== undefined) refsSchema.parse(refs);
            if (after.state === "active") lane.parse(after.attributes["kanban/lane"]);
            priority.parse(after.attributes["kanban/priority"]);
            if (after.attributes["kanban/link"] !== undefined)
              linkSchema.parse(after.attributes["kanban/link"]);
          }
          if (
            token !== this.authority &&
            (before?.attributes["kanban/link"] !== undefined ||
              after?.attributes["kanban/link"] !== undefined) &&
            (before === null ||
              after === null ||
              before.title !== after.title ||
              before.state !== after.state ||
              ["kanban/lane", "kanban/outcome", "kanban/link", "kanban/link-snapshot"].some(
                (key) =>
                  encode(before.attributes[key] ?? null) !== encode(after.attributes[key] ?? null),
              ))
          )
            throw new Fault("linked-card", "Linked card state requires refresh");
        } else {
          const edge = change.before ?? change.after;
          if (edge?.relation === "claims") {
            const source = ctx.graph.all({ where: q.eq("id", edge.from_id), lean: false })[0];
            const target = ctx.graph.all({ where: q.eq("id", edge.to_id), lean: false })[0];
            if (
              (source?.attributes["kanban/ownership-claim"] === true ||
                target?.attributes["kanban/card"] === true ||
                target?.attributes["kanban/task"] === true) &&
              (change.before !== null || token !== this.authority)
            )
              throw new Fault("ownership", "Ownership claim relations are immutable");
          }
        }
      }
    });
    protectProgression(ctx);
  }

  history(id: string): Node[] {
    return this.ctx.graph
      .edges(id, "claims")
      .filter((edge) => edge.to_id === id)
      .map((edge) => this.ctx.graph.show(edge.from_id))
      .filter((record) => record.attributes["kanban/ownership-claim"] === true)
      .toSorted((a, b) =>
        compare(
          text.parse(a.attributes["kanban/claimed-at"]),
          text.parse(b.attributes["kanban/claimed-at"]),
          a.id.localeCompare(b.id),
        ),
      );
  }

  owner(id: string): Json {
    const direct = this.history(id).at(-1);
    const parent = this.parent(id);
    const inherited =
      direct === undefined && parent !== undefined ? this.history(parent.id).at(-1) : undefined;
    const claim = direct ?? inherited;
    if (claim === undefined) return null;

    return {
      ...attribution(this.ctx.graph, text.parse(claim.attributes["kanban/owner"])),
      source: direct === undefined ? "inherited" : "direct",
      claimId: claim.id,
      claimedAt: claim.attributes["kanban/claimed-at"] ?? null,
      branch: claim.attributes["kanban/branch"] ?? null,
      worktree: claim.attributes["kanban/worktree"] ?? null,
    };
  }

  add(raw: z.input<typeof addInput>): Node {
    const input = addInput.parse({
      ...raw,
      byIdentity: raw.byIdentity ?? callerActor(this.ctx),
    });

    return this.ctx.graph.atomic(() => {
      if (input.epic !== undefined) {
        const epic = this.writable(input.epic);
        if (
          epic.attributes["kanban/type"] !== "epic" ||
          epic.state !== "active" ||
          input.type !== "feature"
        )
          throw new Fault("kanban", "Features attach to an active epic");
      }

      const attrs: Attributes = {
        "kanban/card": true,
        "kanban/type": input.type,
        "kanban/lane": input.lane,
        "kanban/priority": input.priority,
        "kanban/labels": input.labels ?? [],
      };
      if (input.progression !== undefined) attrs["kanban/progression"] = input.progression;
      for (const key of ["body", "acceptance", "summary"] as const)
        if (input[key] !== undefined) attrs[`kanban/${key}`] = input[key];
      if (input.byIdentity !== undefined) attrs["identity/by-identity"] = input.byIdentity;

      const reporter = input.reportedBy ?? input.byIdentity;
      if (reporter !== undefined) attrs["kanban/reported-by"] = reporter;

      const card = this.ctx.graph.add({ title: input.title, attributes: attrs });
      if (input.epic !== undefined) this.ctx.graph.connect(input.epic, card.id, "parent-of");
      if (input.byIdentity !== undefined)
        attribute(this.ctx, card.id, input.byIdentity, "attributed");
      if (reporter !== undefined) attribute(this.ctx, card.id, reporter, "reported");

      return card;
    }, this.authority);
  }

  update(raw: z.infer<typeof updateInput>): Node {
    const input = updateInput.parse(raw);
    return this.ctx.graph.atomic(() => {
      const card = this.writable(input.id);
      if (input.lane !== undefined) {
        if (card.attributes["kanban/card"] !== true || card.state !== "active")
          throw new Fault("kanban", "Only active cards have lanes");
        this.blockages.assertLaneChange(card.id);
      }
      const attributes: Attributes = {};
      for (const key of ["body", "acceptance", "summary", "lane", "progression"] as const)
        if (input[key] !== undefined) attributes[`kanban/${key}`] = input[key];
      if (input.title === undefined && Object.keys(attributes).length === 0)
        throw new Fault("kanban", "Supply a work field or lane to update");
      return this.ctx.graph.update(input.id, {
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.expectedRevision === undefined
          ? {}
          : { expectedRevision: input.expectedRevision }),
        attributes,
      });
    }, this.authority);
  }

  task(raw: z.input<typeof taskInput>): Node {
    const input = taskInput.parse({ ...raw, byIdentity: raw.byIdentity ?? callerActor(this.ctx) });
    return this.ctx.graph.atomic(() => {
      const parent = this.writable(input.feature);
      if (
        parent.state !== "active" ||
        !(
          parent.attributes["kanban/type"] === "feature" ||
          parent.attributes["kanban/task"] === true
        )
      )
        throw new Fault("kanban", "Tasks require an active feature or task");

      const attributes: Attributes = { "kanban/task": true };
      for (const key of ["body", "acceptance", "summary"] as const)
        if (input[key] !== undefined) attributes[`kanban/${key}`] = input[key];
      if (input.byIdentity !== undefined) attributes["identity/by-identity"] = input.byIdentity;
      const task = this.ctx.graph.add({ title: input.title, attributes });
      this.ctx.graph.connect(input.feature, task.id, "parent-of");
      for (const dependency of input.dependencies)
        this.ctx.graph.connect(task.id, dependency, "depends-on");
      if (input.byIdentity !== undefined)
        attribute(this.ctx, task.id, input.byIdentity, "attributed");

      return task;
    }, this.authority);
  }

  claim(raw: z.infer<typeof claimInput>): { result: string; claim: Node } {
    const input = claimInput.parse({
      ...raw,
      byIdentity: raw.byIdentity ?? callerActor(this.ctx),
    });
    const owner = requireValue(input.owner ?? callerActor(this.ctx), "Supply --owner or BL_ACTOR");

    return this.ctx.graph.atomic(() => {
      const target = this.writable(input.id);
      if (target.state !== "active" || target.attributes["kanban/type"] === "epic")
        throw new Fault("claim", "Only active features and tasks can be claimed");
      if (target.attributes["kanban/type"] === "feature" && input.branch === undefined)
        throw new Fault("claim", "Feature claim requires a branch");
      if (target.attributes["kanban/lane"] === "refinement")
        throw new Fault("claim", "Move refined work to pending before claiming");
      const blockages = this.blockages.compact(target.id);
      if (blockages.length > 0)
        throw new Fault("blocked", "Resolve effective blockages before claiming work", {
          id: target.id,
          blockages,
        });
      if (this.ctx.graph.all({ ready: true, where: q.eq("id", target.id) }).length === 0)
        throw new Fault("claim", "Resolve dependencies before claiming");
      const attrs: Attributes = {
        "kanban/ownership-claim": true,
        "kanban/owner": owner,
        "kanban/claimed-at": new Date(this.ctx.clock.now()).toISOString(),
      };
      if (input.branch !== undefined) attrs["kanban/branch"] = input.branch;
      if (input.worktree !== undefined) attrs["kanban/worktree"] = input.worktree;
      if (input.runId !== undefined) attrs["kanban/run-id"] = input.runId;
      if (input.byIdentity !== undefined) attrs["identity/by-identity"] = input.byIdentity;

      const previous = this.history(input.id).at(-1);
      if (previous?.attributes["kanban/owner"] === owner) {
        for (const key of [
          "kanban/branch",
          "kanban/worktree",
          "kanban/run-id",
          "identity/by-identity",
        ])
          if (previous.attributes[key] !== attrs[key])
            throw new Fault("claim", "Same owner with changed context is ambiguous");
        return { result: "unchanged", claim: previous };
      }

      if (previous !== undefined)
        attrs["kanban/claimed-at"] = new Date(
          Math.max(
            this.ctx.clock.now(),
            Date.parse(text.parse(previous.attributes["kanban/claimed-at"])) + 1,
          ),
        ).toISOString();
      const claim = this.ctx.graph.add({
        title: `Claim ${input.id}`,
        state: "closed",
        attributes: attrs,
      });
      this.ctx.graph.connect(claim.id, input.id, "claims");
      attribute(this.ctx, claim.id, owner, "claimed");
      if (input.byIdentity !== undefined)
        attribute(this.ctx, claim.id, input.byIdentity, "attributed");
      if (target.attributes["kanban/card"] === true) this.blockages.claimLane(input.id);

      return { result: "claimed", claim };
    }, this.authority);
  }

  finish(id: string, outcome = "done"): Node {
    return this.ctx.graph.atomic(() => {
      const card = this.writable(id);
      if (card.state !== "active") throw new Fault("finish", "Card is not active");

      if (policyApplies(this.ctx.graph, id)) {
        const unresolved = unresolvedDescendants(this.ctx.graph, id);
        if (unresolved.length > 0) {
          const unfinished = unresolved.map(({ id: childId, title }) => ({
            id: childId,
            title,
          }));
          if (outcome === "abandoned")
            throw new Fault("progression", "Children progression cannot abandon unfinished work", {
              unfinished,
            });
          throw new Fault("progression", "Finish contained work before completing the parent", {
            unfinished,
          });
        }
      } else {
        const descendants = this.unfinished(id);
        if (outcome !== "abandoned" && descendants.length > 0)
          throw new Fault("finish", "Finish child work before completing the parent", {
            unfinished: descendants.map(({ id: childId, title }) => ({ id: childId, title })),
          });
        // Free cards cascade explicitly, but never abandon an opted child's unfinished work.
        if (outcome === "abandoned")
          for (const child of descendants) {
            if (!policyApplies(this.ctx.graph, child.id)) continue;
            const unresolved = unresolvedDescendants(this.ctx.graph, child.id);
            if (unresolved.length > 0)
              throw new Fault(
                "progression",
                "Children progression cannot abandon unfinished work",
                {
                  unfinished: unresolved.map(({ id: childId, title }) => ({
                    id: childId,
                    title,
                  })),
                },
              );
          }
        for (const child of descendants) this.writable(child.id);
        for (const child of descendants)
          this.ctx.graph.update(child.id, {
            state: "closed",
            attributes: {
              "kanban/lane": null,
              "kanban/previous-lane": child.attributes["kanban/lane"] ?? null,
              "kanban/outcome": "unactioned",
              "kanban/closed-by": "parent-cascade",
              "kanban/cascade-root": id,
            },
          });
      }

      return this.ctx.graph.update(id, {
        state: "closed",
        attributes: {
          "kanban/lane": null,
          "kanban/previous-lane": card.attributes["kanban/lane"] ?? null,
          "kanban/outcome": text.parse(outcome),
        },
      });
    }, this.authority);
  }

  reopen(id: string): Node {
    return this.ctx.graph.atomic(() => {
      const card = this.writable(id);
      if (card.state !== "closed") throw new Fault("reopen", "Card must be closed");

      if (card.attributes["kanban/outcome"] === "abandoned")
        for (const child of this.ctx.graph.subgraph(id).nodes)
          if (
            child.id !== id &&
            child.attributes["kanban/cascade-root"] === id &&
            child.attributes["kanban/closed-by"] === "parent-cascade"
          ) {
            this.ctx.graph.update(child.id, {
              state: "active",
              attributes: {
                "kanban/lane":
                  child.attributes["kanban/card"] === true
                    ? (child.attributes["kanban/previous-lane"] ?? "pending")
                    : null,
                "kanban/outcome": null,
                "kanban/closed-by": null,
                "kanban/cascade-root": null,
              },
            });
          }
      return this.ctx.graph.update(id, {
        state: "active",
        attributes: {
          "kanban/lane":
            card.attributes["kanban/task"] === true
              ? null
              : (card.attributes["kanban/previous-lane"] ?? "pending"),
          "kanban/outcome": null,
          "kanban/closed-by": null,
          "kanban/cascade-root": null,
        },
      });
    }, this.authority);
  }

  note(id: string, body: string, attributes: Attributes = {}): Node {
    const defaultActor =
      attributes["identity/by-identity"] === undefined ? callerActor(this.ctx) : undefined;
    if (defaultActor !== undefined)
      attributes = { ...attributes, "identity/by-identity": defaultActor };
    return this.ctx.graph.atomic(() => {
      this.target(id);
      const note = this.ctx.graph.note(id, body, attributes);
      const actor = attributes["identity/by-identity"];
      if (typeof actor === "string") attribute(this.ctx, note.id, actor, "attributed");

      return note;
    });
  }

  annotate(id: string, attributes: Attributes): Node {
    this.target(id);

    return this.ctx.graph.update(id, { attributes });
  }

  references(
    id: string,
    operation: "list" | "add" | "remove",
    url?: string,
    label?: string,
    expectedRevision?: number,
  ): unknown {
    return this.ctx.graph.atomic(() => {
      const card = this.target(id);
      let refs = refsSchema.parse(card.attributes["kanban/external-refs"] ?? []);
      if (operation === "list") return { card: id, refs };

      const target = requireValue(url, "Reference URL required");
      const existing = refs.find((ref) => ref.url === target);
      if (operation === "add") {
        const next = referenceSchema.parse({
          url: target,
          ...(label === undefined ? {} : { label }),
        });
        if (existing !== undefined) {
          if (existing.label !== label)
            throw new Fault("reference", "Remove reference before relabelling");
          return { card, refs };
        }
        refs = [...refs, next];
      } else refs = refs.filter((ref) => ref.url !== target);

      return {
        card: this.ctx.graph.update(id, {
          expectedRevision: expectedRevision ?? card.revision,
          attributes: { "kanban/external-refs": jsonSchema.parse(refs) },
        }),
        refs,
      };
    }, this.authority);
  }

  async attach(workspace: string, id: string): Promise<Node> {
    return this.mirror(await this.linkWorkspace(workspace), id);
  }

  async addLink(workspace: string, title: string): Promise<Node> {
    workspace = await this.linkWorkspace(workspace);
    const { id } = idResponse.parse(
      await this.ctx.peers.call(workspace, "kanban", { command: "add", title }),
    );
    try {
      return await this.mirror(workspace, id);
    } catch (error) {
      throw new Fault("link", "Downstream card exists; attach it explicitly", {
        workspace,
        id,
        error: String(error),
      });
    }
  }

  async refresh(id?: string): Promise<unknown[]> {
    const cards =
      id === undefined
        ? this.ctx.graph.all({
            where: q.exists(q.attr("kanban/link")),
          })
        : [this.target(id)];
    const result: unknown[] = [];
    for (const card of cards) {
      const link = linkSchema.parse(card.attributes["kanban/link"]);
      try {
        const view = await this.view(link.card, link.workspace);
        const snapshot = this.snapshot(view.card, view.owner);
        this.ctx.graph.atomic(
          () =>
            this.ctx.graph.update(card.id, {
              title: view.card.title,
              state: view.card.state === "active" ? "active" : "closed",
              expectedRevision: card.revision,
              attributes: {
                "kanban/lane": view.card.attributes["kanban/lane"] ?? null,
                "kanban/outcome": view.card.attributes["kanban/outcome"] ?? null,
                "kanban/link-snapshot": snapshot,
              },
            }),
          this.authority,
        );
        result.push({ id: card.id, status: "live" });
      } catch (error) {
        result.push({ id: card.id, status: "unavailable", error: String(error) });
      }
    }
    return result;
  }

  async card(id: string, history = false): Promise<unknown> {
    const view = await this.view(id);
    const { card } = view;
    const parent = this.parent(id);
    const tasks = this.ctx.graph
      .edges(id, "parent-of")
      .filter((edge) => edge.from_id === id)
      .map((edge) => this.ctx.graph.show(edge.to_id))
      .filter((row) => row.attributes["kanban/task"] === true)
      .map((task) => ({
        ...summary(task),
        blockages: this.blockages.presentationCompact(task.id),
        owner: this.owner(task.id),
        status:
          task.state !== "active"
            ? "closed"
            : this.blockages.effective(task.id).length > 0 ||
                this.ctx.graph.all({ ready: true, where: q.eq("id", task.id) }).length === 0
              ? "blocked"
              : this.history(task.id).length > 0
                ? "doing"
                : "ready",
      }));

    return {
      ...view,
      blockages: this.blockages.details(id),
      parent: parent === undefined ? null : summary(parent),
      reporter:
        typeof card.attributes["kanban/reported-by"] === "string"
          ? attribution(this.ctx.graph, card.attributes["kanban/reported-by"])
          : null,
      tasks,
      related: this.ctx.graph.edges(id, "depends-on"),
      ...(history ? { history: this.history(id), notes: this.notes(id) } : {}),
    };
  }

  async board(labels: string[] = [], limit = 20, offset = 0): Promise<unknown> {
    const cards = this.ctx.graph
      .all({ where: q.eq(q.attr("kanban/card"), true) })
      .filter((row) =>
        labels.every((label) =>
          stringArray.parse(row.attributes["kanban/labels"] ?? []).includes(label),
        ),
      );
    const views = await Promise.all(
      cards.map(async (card) => {
        const view = await this.view(card.id);
        return {
          ...view,
          card: summary(view.card),
          blockages: this.blockages.presentationCompact(card.id),
        };
      }),
    );

    const active = views.filter((view) => view.card.state === "active");
    const page = active.slice(offset, offset + limit);
    return {
      lanes: Object.fromEntries(
        lane.options.map((name) => [
          name,
          page.filter((view) => view.card.attributes["kanban/lane"] === name),
        ]),
      ),
      closed: views.filter((view) => view.card.state === "closed").length,
      total: active.length,
      nextOffset: offset + page.length < active.length ? offset + page.length : null,
    };
  }

  next(limit = 20, offset = 0): { cards: Node[]; total: number; nextOffset: number | null } {
    const ready = this.ctx.graph
      .all({ ready: true, where: pendingFeaturePredicate })
      .toSorted((a, b) =>
        compare(
          priority.parse(a.attributes["kanban/priority"]),
          priority.parse(b.attributes["kanban/priority"]),
          compare(a.created_at, b.created_at, a.id.localeCompare(b.id)),
        ),
      );
    const cards = ready.slice(offset, offset + limit).map((card) => ({
      ...summary(card),
      blockages: this.blockages.presentationCompact(card.id),
    }));
    return {
      cards,
      total: ready.length,
      nextOffset: offset + cards.length < ready.length ? offset + cards.length : null,
    };
  }

  // -- Private helpers --

  private async view(
    id: string,
    workspace?: string,
  ): Promise<{ card: Node; owner: Json; [key: string]: unknown }> {
    if (workspace !== undefined)
      return cardView.parse(
        await this.ctx.peers.call(workspace, "kanban", { command: "card", id }),
      );
    let card = this.target(id);
    let link: unknown;
    let owner = this.owner(id);
    if (card.attributes["kanban/link"] !== undefined) {
      const target = linkSchema.parse(card.attributes["kanban/link"]);
      try {
        const view = await this.view(target.card, target.workspace);
        card = {
          ...card,
          title: view.card.title,
          state: view.card.state,
          attributes: {
            ...card.attributes,
            "kanban/lane": view.card.attributes["kanban/lane"] ?? null,
            "kanban/outcome": view.card.attributes["kanban/outcome"] ?? null,
          },
        };
        owner = view.owner;
        link = { status: "live", ...target };
      } catch (error) {
        link = {
          status: "unavailable",
          ...target,
          error: String(error),
          snapshot: card.attributes["kanban/link-snapshot"],
        };
      }
    }
    return { card, owner, ...(link === undefined ? {} : { link }) };
  }

  private unfinished(id: string): Node[] {
    return this.ctx.graph
      .subgraph(id)
      .nodes.filter(
        (row) =>
          row.id !== id &&
          row.state === "active" &&
          (row.attributes["kanban/card"] === true || row.attributes["kanban/task"] === true),
      );
  }

  private writable(id: string): Node {
    const record = this.target(id);
    if (record.attributes["kanban/link"] !== undefined)
      throw new Fault("linked-card", "Change the authoritative downstream card");
    return record;
  }

  private target(id: string): Node {
    const record = this.ctx.graph.show(id);
    if (record.attributes["kanban/card"] !== true && record.attributes["kanban/task"] !== true)
      throw new Fault("kanban", "Expected card or task");
    return record;
  }

  private parent(id: string): Node | undefined {
    const edge = this.ctx.graph.edges(id, "parent-of").find((entry) => entry.to_id === id);

    return edge === undefined ? undefined : this.ctx.graph.show(edge.from_id);
  }

  private async linkWorkspace(workspace: string): Promise<string> {
    const peer = await this.ctx.peers.resolve(workspace);
    if (peer.path === this.ctx.workspace)
      throw new Fault("link", "Link must name another workspace");
    return peer.path;
  }

  private async mirror(workspace: string, id: string): Promise<Node> {
    const source = mirrorResponse.parse(
      await this.ctx.peers.call(workspace, "kanban", { command: "card", id }),
    );
    if (source.card.attributes["kanban/card"] !== true || source.card.state !== "active")
      throw new Fault("link", "Only active cards can be attached");
    return this.ctx.graph.atomic(() => {
      if (
        this.ctx.graph.all({ where: q.exists(q.attr("kanban/link")) }).some((card) => {
          const link = linkSchema.parse(card.attributes["kanban/link"]);

          return link.workspace === workspace && link.card === id;
        })
      )
        throw new Fault("link", "Card is already linked");
      return this.ctx.graph.add({
        title: source.card.title,
        attributes: {
          "kanban/card": true,
          "kanban/type": "feature",
          "kanban/priority": "p3",
          "kanban/lane": source.card.attributes["kanban/lane"] ?? "pending",
          "kanban/link": { workspace, card: id },
          "kanban/link-snapshot": this.snapshot(source.card, source.owner),
        },
      });
    }, this.authority);
  }

  private snapshot(card: Pick<Node, "title" | "state" | "attributes">, owner: Json): Attributes {
    return {
      title: card.title,
      state: card.state,
      lane: card.attributes["kanban/lane"] ?? null,
      outcome: card.attributes["kanban/outcome"] ?? null,
      owner,
      "observed-at": new Date(this.ctx.clock.now()).toISOString(),
    };
  }

  private notes(id: string): Node[] {
    return this.ctx.graph
      .edges(id, "notes")
      .filter((edge) => edge.to_id === id)
      .map((edge) => this.ctx.graph.show(edge.from_id))
      .toSorted((a, b) => compare(a.created_at, b.created_at, a.id.localeCompare(b.id)));
  }
}

export function kanban(): Extension {
  return {
    name: "kanban",
    requires: ["identity"],
    activate(ctx) {
      const blockages = new KanbanBlockages(ctx);
      const board = new Kanban(ctx, blockages);
      ctx.registerQuery("kanban-cards", {
        where: q.eq(q.attr("kanban/card"), true),
        description: "Kanban cards",
      });
      ctx.registerQuery("kanban-tasks", {
        where: q.eq(q.attr("kanban/task"), true),
        description: "Feature tasks",
      });
      ctx.registerQuery("kanban-pending", {
        where: pendingFeaturePredicate,
        description: "Pending authoritative features",
      });
      const input = z.compile(
        z.discriminatedUnion("command", [
          addInput.extend({ command: z.literal("add") }),
          ...blockageCommands,
          updateInput.extend({ command: z.literal("update") }),
          claimInput.extend({ command: z.literal("claim") }),
          z.strictObject({
            command: z.literal("board"),
            labels: z.array(text).default([]),
            ...pageInput,
          }),
          z.strictObject({
            command: z.literal("card"),
            id: text,
            history: z.boolean().default(false),
          }),
          z.strictObject({ command: z.literal("next"), ...pageInput }),
          taskInput.extend({ command: z.literal("task") }),
          z.strictObject({ command: z.literal("finish"), id: text, outcome: text.default("done") }),
          z.strictObject({ command: z.literal("reopen"), id: text }),
          z.strictObject({
            command: z.literal("note"),
            id: text,
            text,
            byIdentity: text.optional(),
            kind: text.optional(),
          }),
          z.strictObject({
            command: z.literal("ref"),
            id: text,
            operation: z.enum(["list", "add", "remove"]),
            url: text.optional(),
            label: z.string().optional(),
            expectedRevision: z.number().int().positive().optional(),
          }),
          z.discriminatedUnion("operation", [
            z.strictObject({
              command: z.literal("link"),
              operation: z.literal("attach"),
              workspace: text,
              id: text,
            }),
            z.strictObject({
              command: z.literal("link"),
              operation: z.literal("add"),
              workspace: text,
              title: text,
            }),
            z.strictObject({
              command: z.literal("link"),
              operation: z.literal("refresh"),
              id: text.optional(),
            }),
          ]),
          z.strictObject({ command: z.literal("priority"), id: text, priority }),
          z.strictObject({ command: z.literal("label"), id: text, labels: z.array(text) }),
        ]),
      );
      ctx.register(
        defineOp({
          name: "kanban",
          input,
          output: jsonSchema,
          about:
            "Body: problem, outcome, scope and pointers. Acceptance: verifiable criteria. Summary: one current account of decisions, verification and next action; replace it while preserving useful conclusions. Notes: selective supporting evidence. Parent-of groups work; depends-on orders prerequisites. Linked cards mirror their source. Progression is free by default; --progression children gates review, production and successful close on all nested parent-of work.",
          primer:
            "Select with board/next, then read card and parent. Keep draft briefs in refinement and move scoped work to pending. Give each child its own brief and criteria. Claim available work (features require a branch; owner defaults to BL_ACTOR). Record operational impediments with block --reason and optional --needed-from; effective unresolved blockages on a card or any ancestor prevent claims and completion and project cards into blocked until resolved with unblock --resolution. Verify acceptance and finish children before the parent. --progression children gates nested work before review, production or successful close. Process exit, review and merge are not completion. Change linked work at its source.",
          cli: {
            description:
              "Boards and work ownership; --progression children gates review on child completion",
            examples: [
              "bl kanban board",
              'bl kanban add "Investigate issue"',
              "bl kanban claim ID --owner IDENTITY --branch topic",
              "bl kanban card ID",
            ],
            commands: {
              add: {
                description:
                  "Add card; use --progression children to gate review on contained work",
                positionals: [{ name: "title", type: "string", required: true }],
                flags: {
                  type: { type: "string" },
                  lane: {
                    type: "string",
                    description:
                      "Default pending. Use refinement for drafts; move to pending before claiming",
                  },
                  priority: { type: "string" },
                  body: { type: "string", description: "Problem, outcome, scope and pointers" },
                  acceptance: { type: "string", description: "Verifiable acceptance criteria" },
                  summary: {
                    type: "string",
                    description: "Current decisions, verification and next action",
                  },
                  epic: { type: "string" },
                  progression: {
                    type: "string",
                    description:
                      "Allowed values: children | free (default). children gates review, production and close on contained work",
                  },
                  "by-identity": {
                    key: "byIdentity",
                    type: "string",
                    description: "Author (defaults to BL_ACTOR)",
                  },
                  "reported-by": { key: "reportedBy", type: "string" },
                  labels: {
                    type: "string",
                    multiple: true,
                    description: "Repeat per label: --labels one --labels two",
                  },
                },
              },
              block: {
                description: "Record an explicit operational blockage",
                positionals: [{ name: "id", type: "string", required: true }],
                flags: {
                  reason: { type: "string", required: true },
                  "needed-from": { key: "neededFrom", type: "string" },
                  "by-identity": {
                    key: "byIdentity",
                    type: "string",
                    description: "Author (defaults to BL_ACTOR)",
                  },
                },
              },
              unblock: {
                description: "Resolve a Kanban blockage",
                positionals: [{ name: "id", type: "string", required: true }],
                flags: {
                  resolution: { type: "string", required: true },
                  "by-identity": {
                    key: "byIdentity",
                    type: "string",
                    description: "Resolver (defaults to BL_ACTOR)",
                  },
                },
              },
              update: {
                description: "Revise the brief, criteria or current summary",
                positionals: [{ name: "id", type: "string", required: true }],
                flags: {
                  title: { type: "string" },
                  body: { type: "string" },
                  acceptance: { type: "string" },
                  summary: {
                    type: "string",
                    description: "Replace the current account; preserve useful conclusions",
                  },
                  lane: {
                    type: "string",
                    description:
                      "refinement, pending, in_review or in_production; use block for operational holds",
                  },
                  progression: {
                    type: "string",
                    description:
                      "Allowed values: children | free (default). children gates review, production and close on contained work",
                  },
                  "expected-revision": { key: "expectedRevision", type: "number" },
                },
              },
              board: {
                description: "Paged board summaries, without briefs or history",
                flags: {
                  labels: {
                    type: "string",
                    multiple: true,
                    description: "Repeat per label: --labels one --labels two",
                  },
                  limit: { type: "number", description: "Page size (default 20, maximum 100)" },
                  offset: {
                    type: "number",
                    description: "Continue at nextOffset; pages are not a snapshot",
                  },
                },
              },
              next: {
                description: "Paged ready feature summaries",
                flags: {
                  limit: { type: "number", description: "Page size (default 20, maximum 100)" },
                  offset: {
                    type: "number",
                    description: "Continue at nextOffset; pages are not a snapshot",
                  },
                },
              },
              card: {
                description: "Current brief, criteria, summary, owner and task summaries",
                positionals: [{ name: "id", type: "string", required: true }],
                flags: {
                  history: {
                    type: "boolean",
                    description: "Include all task-local notes and ownership claims",
                  },
                },
              },
              claim: {
                description:
                  "Claim pending work; features require --branch. Move refinement to pending first",
                positionals: [{ name: "id", type: "string", required: true }],
                flags: {
                  owner: { type: "string", description: "Owner (defaults to BL_ACTOR)" },
                  branch: {
                    type: "string",
                    description:
                      "Required for features: records a branch name; does not create a Git branch",
                  },
                  worktree: { type: "string" },
                  "by-identity": {
                    key: "byIdentity",
                    type: "string",
                    description: "Author (defaults to BL_ACTOR)",
                  },
                  "run-id": { key: "runId", type: "string" },
                },
              },
              finish: {
                description: "Complete work; unfinished children require explicit abandonment",
                positionals: [{ name: "id", type: "string", required: true }],
                flags: { outcome: { type: "string" } },
              },
              reopen: {
                description: "Reopen",
                positionals: [{ name: "id", type: "string", required: true }],
              },
              task: {
                description: "Add a child task to an active feature or task",
                positionals: [
                  { name: "feature", type: "string", required: true },
                  { name: "title", type: "string", required: true },
                ],
                flags: {
                  body: { type: "string" },
                  acceptance: { type: "string" },
                  summary: { type: "string" },
                  dependencies: { type: "string", multiple: true },
                  "by-identity": {
                    key: "byIdentity",
                    type: "string",
                    description: "Author (defaults to BL_ACTOR)",
                  },
                },
              },
              ref: {
                description: "External references",
                selector: "operation",
                commands: {
                  list: {
                    description: "References",
                    positionals: [{ name: "id", type: "string", required: true }],
                  },
                  add: {
                    description: "Add reference",
                    positionals: [
                      { name: "id", type: "string", required: true },
                      { name: "url", type: "string", required: true },
                    ],
                    flags: {
                      label: { type: "string" },
                      "expected-revision": { key: "expectedRevision", type: "number" },
                    },
                  },
                  rm: {
                    value: "remove",
                    description: "Remove reference",
                    positionals: [
                      { name: "id", type: "string", required: true },
                      { name: "url", type: "string", required: true },
                    ],
                    flags: { "expected-revision": { key: "expectedRevision", type: "number" } },
                  },
                },
              },
              link: {
                description: "Linked cards",
                selector: "operation",
                commands: {
                  attach: {
                    description: "Attach downstream",
                    positionals: [{ name: "id", type: "string", required: true }],
                    flags: { to: { key: "workspace", type: "string", required: true } },
                  },
                  add: {
                    description: "Create downstream",
                    positionals: [{ name: "title", type: "string", required: true }],
                    flags: { to: { key: "workspace", type: "string", required: true } },
                  },
                  refresh: {
                    description: "Refresh snapshots",
                    positionals: [{ name: "id", type: "string" }],
                  },
                },
              },
              priority: {
                description: "Set priority",
                positionals: [
                  { name: "id", type: "string", required: true },
                  { name: "priority", type: "string", required: true },
                ],
              },
              label: {
                description: "Set labels",
                positionals: [{ name: "id", type: "string", required: true }],
                flags: { labels: { type: "string", multiple: true, required: true } },
              },
              note: {
                description:
                  "Record selective evidence; use update --summary for the current account",
                positionals: [
                  { name: "id", type: "string", required: true },
                  { name: "text", type: "string", required: true },
                ],
                flags: {
                  "by-identity": {
                    key: "byIdentity",
                    type: "string",
                    description: "Author (defaults to BL_ACTOR)",
                  },
                  kind: { type: "string" },
                },
              },
            },
          },
          async handler(commandInput) {
            const result = await match(commandInput)
              .with({ command: "add" }, (value) => {
                const { command: _, ...request } = value;

                return board.add(request);
              })
              .with({ command: "block" }, (value) => {
                const { command: _, ...request } = value;
                return blockages.block(request);
              })
              .with({ command: "unblock" }, (value) => {
                const { command: _, ...request } = value;
                return blockages.unblock(request);
              })
              .with({ command: "claim" }, (value) => {
                const { command: _, ...request } = value;

                return board.claim(request);
              })
              .with({ command: "update" }, (value) => {
                const { command: _, ...request } = value;
                const card = board.update(request);
                return { id: card.id, revision: card.revision };
              })
              .with({ command: "board" }, ({ labels, limit, offset }) =>
                board.board(labels, limit, offset),
              )
              .with({ command: "card" }, ({ id, history }) => board.card(id, history))
              .with({ command: "next" }, ({ limit, offset }) => board.next(limit, offset))
              .with({ command: "task" }, (value) => {
                const { command: _, ...request } = value;
                return board.task(request);
              })
              .with({ command: "finish" }, ({ id, outcome }) => board.finish(id, outcome))
              .with({ command: "reopen" }, ({ id }) => board.reopen(id))
              .with({ command: "note" }, (value) => {
                const attrs: Attributes = {};
                if (value.byIdentity !== undefined)
                  attrs["identity/by-identity"] = value.byIdentity;
                if (value.kind !== undefined) attrs["note/kind"] = value.kind;

                return board.note(value.id, value.text, attrs);
              })
              .with({ command: "ref" }, (value) =>
                board.references(
                  value.id,
                  value.operation,
                  value.url,
                  value.label,
                  value.expectedRevision,
                ),
              )
              .with({ command: "priority" }, ({ id, priority: level }) =>
                board.annotate(id, { "kanban/priority": level }),
              )
              .with({ command: "label" }, ({ id, labels }) =>
                board.annotate(id, { "kanban/labels": labels }),
              )
              .with({ command: "link", operation: "refresh" }, ({ id }) => board.refresh(id))
              .with({ command: "link", operation: "add" }, ({ workspace, title }) =>
                board.addLink(workspace, title),
              )
              .with({ command: "link", operation: "attach" }, ({ workspace, id }) =>
                board.attach(workspace, id),
              )
              .exhaustive();

            return jsonSchema.parse(result);
          },
        }),
      );
      ctx.register(
        defineOp({
          name: "kanban-export",
          input: exportInput,
          output: jsonSchema,
          cli: {
            description: "Export card subtree",
            positionals: [{ name: "id", type: "string", required: true }],
          },
          handler: ({ id }) => jsonSchema.parse(ctx.graph.subgraph(id)),
        }),
      );
    },
  };
}

export default kanban();

// -- Private helpers --

function summary(node: Node): Node {
  return {
    ...node,
    attributes: Object.fromEntries(
      Object.entries(node.attributes).filter(([key]) =>
        [
          "kanban/card",
          "kanban/task",
          "kanban/type",
          "kanban/lane",
          "kanban/progression",
          "kanban/priority",
          "kanban/labels",
          "kanban/outcome",
        ].includes(key),
      ),
    ),
  };
}

function compare(left: string, right: string, fallback: number): number {
  const order = left.localeCompare(right);

  return order === 0 ? fallback : order;
}
