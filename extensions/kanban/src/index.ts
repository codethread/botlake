import {
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

const text = z.string().trim().min(1);

const lane = z.enum(["refinement", "pending", "claimed", "in_review", "in_production"]);

const priority = z.enum(["p1", "p2", "p3", "p4"]);

const pendingFeaturePredicate = q.and(
  q.eq(q.attr("kanban/card"), true),
  q.eq(q.attr("kanban/type"), "feature"),
  q.eq(q.attr("kanban/lane"), "pending"),
  q.missing(q.attr("kanban/link")),
);

const refsSchema = z
  .array(
    z.strictObject({
      url: z.url({ protocol: /^https?$/u }),
      label: z.string().optional(),
    }),
  )
  .superRefine((refs, ctx) => {
    if (new Set(refs.map((ref) => ref.url)).size !== refs.length)
      ctx.addIssue({ code: "custom", message: "Duplicate reference URL" });
  });

const linkSchema = z.strictObject({ workspace: text, card: text });

const claimInput = z.strictObject({
  id: text,
  owner: text.optional(),
  branch: text.optional(),
  worktree: text.optional(),
  runId: text.optional(),
  byIdentity: text.optional(),
});

const addInput = z.strictObject({
  title: text,
  type: z.enum(["feature", "epic"]).default("feature"),
  lane: z.enum(["pending", "refinement"]).default("pending"),
  priority: priority.default("p3"),
  body: z.string().optional(),
  epic: text.optional(),
  byIdentity: text.optional(),
  reportedBy: text.optional(),
  labels: z.array(text).optional(),
});

export class Kanban {
  private readonly authority = Symbol("kanban");

  constructor(private readonly ctx: Context) {
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
          if (edge?.relation === "claims" && (change.before !== null || token !== this.authority))
            throw new Fault("ownership", "Ownership claim relations are immutable");
        }
      }
    });
  }

  history(id: string): Node[] {
    return this.ctx.graph
      .edges(id, "claims")
      .filter((edge) => edge.to_id === id)
      .map((edge) => this.ctx.graph.show(edge.from_id))
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
      if (input.body !== undefined) attrs["kanban/body"] = input.body;
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

  task(feature: string, title: string, dependencies: string[] = []): Node {
    return this.ctx.graph.atomic(() => {
      const parent = this.writable(feature);
      if (parent.attributes["kanban/type"] !== "feature" || parent.state !== "active")
        throw new Fault("kanban", "Tasks require an active feature");

      const task = this.ctx.graph.add({ title, attributes: { "kanban/task": true } });
      this.ctx.graph.connect(feature, task.id, "parent-of");
      for (const dependency of dependencies)
        this.ctx.graph.connect(task.id, dependency, "depends-on");

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
      if (target.attributes["kanban/card"] === true)
        this.ctx.graph.update(input.id, { attributes: { "kanban/lane": "claimed" } });

      return { result: "claimed", claim };
    }, this.authority);
  }

  finish(id: string, outcome = "done"): Node {
    return this.ctx.graph.atomic(() => {
      const card = this.writable(id);
      if (card.state !== "active") throw new Fault("finish", "Card is not active");

      if (
        card.attributes["kanban/type"] === "epic" &&
        !["pending", "refinement"].includes(lane.parse(card.attributes["kanban/lane"]))
      )
        throw new Fault("finish", "Epic must be pending or refinement");

      const descendants = this.ctx.graph
        .subgraph(id)
        .nodes.filter(
          (row) =>
            row.id !== id &&
            row.state === "active" &&
            (row.attributes["kanban/card"] === true || row.attributes["kanban/task"] === true),
        );
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

      if (
        card.attributes["kanban/type"] === "epic" &&
        card.attributes["kanban/outcome"] !== "abandoned"
      )
        throw new Fault("reopen", "Completed epic cannot be reopened");
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
        const next = refsSchema.element.parse({
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
          attributes: { "kanban/external-refs": z.json().parse(refs) },
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
    const { id } = z
      .object({ id: text })
      .parse(await this.ctx.peers.call(workspace, "kanban", { command: "add", title }));
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
        const view = await this.card(link.card, link.workspace);
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

  async card(
    id: string,
    workspace?: string,
  ): Promise<{ card: Node; owner: Json; [key: string]: unknown }> {
    if (workspace !== undefined)
      return z
        .object({ card: nodeSchema, owner: z.json() })
        .loose()
        .parse(await this.ctx.peers.call(workspace, "kanban", { command: "card", id }));
    let card = this.target(id);
    let link: unknown;
    let owner = this.owner(id);
    if (card.attributes["kanban/link"] !== undefined) {
      const target = linkSchema.parse(card.attributes["kanban/link"]);
      try {
        const view = await this.card(target.card, target.workspace);
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
    const tasks = this.ctx.graph
      .edges(id, "parent-of")
      .filter((edge) => edge.from_id === id)
      .map((edge) => this.ctx.graph.show(edge.to_id))
      .filter((row) => row.attributes["kanban/task"] === true)
      .map((task) => ({
        ...task,
        owner: this.owner(task.id),
        status:
          task.state !== "active"
            ? "closed"
            : this.ctx.graph.all({ ready: true, where: q.eq("id", task.id) }).length === 0
              ? "blocked"
              : this.history(task.id).length > 0
                ? "doing"
                : "ready",
        latestNote: this.notes(task.id).at(-1) ?? null,
      }));

    return {
      card,
      owner,
      history: this.history(id),
      reporter:
        typeof card.attributes["kanban/reported-by"] === "string"
          ? attribution(this.ctx.graph, card.attributes["kanban/reported-by"])
          : null,
      tasks,
      notes: this.notes(id),
      related: this.ctx.graph.edges(id, "depends-on"),
      ...(link === undefined ? {} : { link }),
    };
  }

  async board(labels: string[] = []): Promise<unknown> {
    const cards = this.ctx.graph.all({ where: q.eq(q.attr("kanban/card"), true) }).filter((row) =>
      labels.every((label) =>
        z
          .array(z.string())
          .parse(row.attributes["kanban/labels"] ?? [])
          .includes(label),
      ),
    );
    const views = await Promise.all(cards.map((card) => this.card(card.id)));

    return {
      lanes: Object.fromEntries(
        lane.options.map((name) => [
          name,
          views.filter(
            (view) => view.card.state === "active" && view.card.attributes["kanban/lane"] === name,
          ),
        ]),
      ),
      closed: views.filter((view) => view.card.state === "closed").length,
      epics: views.filter((view) => view.card.attributes["kanban/type"] === "epic"),
    };
  }

  next(): Node[] {
    return this.ctx.graph
      .all({ ready: true, where: pendingFeaturePredicate })
      .toSorted((a, b) =>
        compare(
          priority.parse(a.attributes["kanban/priority"]),
          priority.parse(b.attributes["kanban/priority"]),
          compare(a.created_at, b.created_at, a.id.localeCompare(b.id)),
        ),
      );
  }

  // -- Private helpers --

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
    const source = z
      .object({
        card: z.object({
          id: text,
          title: text,
          state: z.enum(["active", "closed", "replaced"]),
          attributes: z.record(z.string(), z.json()),
        }),
        owner: z.json(),
      })
      .parse(await this.ctx.peers.call(workspace, "kanban", { command: "card", id }));
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
      const board = new Kanban(ctx);
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
      const input = z.discriminatedUnion("command", [
        addInput.extend({ command: z.literal("add") }),
        claimInput.extend({ command: z.literal("claim") }),
        z.strictObject({ command: z.literal("board"), labels: z.array(text).default([]) }),
        z.strictObject({ command: z.literal("card"), id: text }),
        z.strictObject({ command: z.literal("next") }),
        z.strictObject({
          command: z.literal("task"),
          feature: text,
          title: text,
          dependencies: z.array(text).default([]),
        }),
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
      ]);
      ctx.register(
        defineOp({
          name: "kanban",
          input,
          output: z.json(),
          primer:
            "Inspect board or next, add a feature and its tasks, then claim work with an owner and branch. Authorship and omitted claim owners default to the caller's BL_ACTOR; explicit flags win. Claims preserve ownership history. Finish records a work outcome; an agent process exiting does not finish its card. Linked cards are read-only mirrors: change the downstream card and refresh the snapshot.",
          cli: {
            description: "Boards, ownership, tasks and linked cards",
            examples: [
              "bl kanban board",
              'bl kanban add "Investigate issue"',
              "bl kanban claim ID --owner IDENTITY --branch topic",
              "bl kanban card ID",
            ],
            commands: {
              add: {
                description: "Add card",
                positionals: [{ name: "title", type: "string", required: true }],
                flags: {
                  type: { type: "string" },
                  lane: { type: "string" },
                  priority: { type: "string" },
                  body: { type: "string" },
                  epic: { type: "string" },
                  "by-identity": {
                    key: "byIdentity",
                    type: "string",
                    description: "Author (defaults to BL_ACTOR)",
                  },
                  "reported-by": { key: "reportedBy", type: "string" },
                  labels: { type: "string", multiple: true },
                },
              },
              board: {
                description: "Board",
                flags: { labels: { type: "string", multiple: true } },
              },
              next: { description: "Ready features" },
              card: {
                description: "Card",
                positionals: [{ name: "id", type: "string", required: true }],
              },
              claim: {
                description: "Claim or hand off",
                positionals: [{ name: "id", type: "string", required: true }],
                flags: {
                  owner: { type: "string", description: "Owner (defaults to BL_ACTOR)" },
                  branch: { type: "string" },
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
                description: "Finish",
                positionals: [{ name: "id", type: "string", required: true }],
                flags: { outcome: { type: "string" } },
              },
              reopen: {
                description: "Reopen",
                positionals: [{ name: "id", type: "string", required: true }],
              },
              task: {
                description: "Add task",
                positionals: [
                  { name: "feature", type: "string", required: true },
                  { name: "title", type: "string", required: true },
                ],
                flags: { dependencies: { type: "string", multiple: true } },
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
                description: "Add note",
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
              .with({ command: "claim" }, (value) => {
                const { command: _, ...request } = value;

                return board.claim(request);
              })
              .with({ command: "board" }, ({ labels }) => board.board(labels))
              .with({ command: "card" }, ({ id }) => board.card(id))
              .with({ command: "next" }, () => board.next())
              .with({ command: "task" }, ({ feature, title, dependencies }) =>
                board.task(feature, title, dependencies),
              )
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

            return z.json().parse(result);
          },
        }),
      );
      ctx.register(
        defineOp({
          name: "kanban-export",
          input: z.strictObject({ id: text }),
          output: z.json(),
          cli: {
            description: "Export card subtree",
            positionals: [{ name: "id", type: "string", required: true }],
          },
          handler: ({ id }) => z.json().parse(ctx.graph.subgraph(id)),
        }),
      );
    },
  };
}

export default kanban();

// -- Private helpers --

function compare(left: string, right: string, fallback: number): number {
  const order = left.localeCompare(right);

  return order === 0 ? fallback : order;
}
