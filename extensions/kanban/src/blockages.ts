import {
  canonical,
  Fault,
  q,
  requireValue,
  type Context,
  type Edge,
  type Json,
  type Mutation,
  type Node,
} from "@botlake/core";
import { attribute, attribution, callerActor } from "@botlake/extension-identity";
import { z } from "zod";

const text = z.compile(z.string().trim().min(1));
const blockInput = z.compile(
  z.strictObject({
    id: text,
    reason: text,
    neededFrom: text.optional(),
    byIdentity: text.optional(),
  }),
);
const unblockInput = z.compile(
  z.strictObject({
    id: text,
    resolution: text,
    byIdentity: text.optional(),
  }),
);

export const blockageCommands = [
  blockInput.extend({ command: z.literal("block") }),
  unblockInput.extend({ command: z.literal("unblock") }),
] as const;

export type BlockageSummary = Record<string, Json> & {
  id: string;
  domain: string;
  target: string;
  reason: string;
};

export class KanbanBlockages {
  private readonly authority = Symbol("kanban-blockages");
  private readonly bookmark = "kanban/blockage-previous-lane";

  constructor(private readonly ctx: Context) {
    ctx.graph.protect((changes, token) => {
      this.protectRemovedContainment(changes);
      for (const change of changes) {
        if (change.kind === "node") {
          const owned =
            change.before?.attributes["work/domain"] === "kanban" &&
            change.before.attributes["work/blockage"] === true;
          const createsOwned =
            change.after?.attributes["work/domain"] === "kanban" &&
            change.after.attributes["work/blockage"] === true;
          if ((owned || createsOwned) && token !== this.authority)
            throw new Fault("blockage", "Kanban blockages require the Kanban blockage API");
          if (
            token !== this.authority &&
            canonical(change.before?.attributes[this.bookmark] ?? null) !==
              canonical(change.after?.attributes[this.bookmark] ?? null)
          )
            throw new Fault("blockage", "Blocked-lane bookmarks require the Kanban blockage API");
          if (
            change.before?.state === "active" &&
            change.after !== null &&
            change.after.state !== "active" &&
            this.effective(change.before.id).length > 0
          )
            throw new Fault("blocked", "Resolve effective blockages before closing work", {
              id: change.after.id,
              blockages: this.compact(change.after.id),
            });
          if (
            token === undefined &&
            change.before?.state === "active" &&
            change.after?.state === "active" &&
            change.after.attributes["kanban/card"] === true &&
            canonical(change.before.attributes["kanban/lane"] ?? null) !==
              canonical(change.after.attributes["kanban/lane"] ?? null)
          ) {
            const visible = this.presentation(change.after.id).length > 0;
            if (change.after.attributes["kanban/lane"] === "blocked" && !visible)
              throw new Fault("blocked", "Blocked lane requires a visible blockage");
            if (change.after.attributes["kanban/lane"] !== "blocked" && visible)
              throw new Fault(
                "blocked",
                "Resolve visible blockages before leaving the blocked lane",
              );
          }
        } else {
          const edge = change.before ?? change.after;
          if (edge?.relation === "blocks") {
            const source = this.ctx.graph.all({ where: q.eq("id", edge.from_id), lean: false })[0];
            if (
              source?.attributes["work/domain"] === "kanban" &&
              source.attributes["work/blockage"] === true &&
              token !== this.authority
            )
              throw new Fault("blockage", "Kanban blockage links are immutable");
          }
          if (edge?.relation === "parent-of" || edge?.relation === "depends-on") {
            const from = this.ctx.graph.all({ where: q.eq("id", edge.from_id), lean: false })[0];
            const to = this.ctx.graph.all({ where: q.eq("id", edge.to_id), lean: false })[0];
            if (
              from?.attributes["work/blockage"] === true ||
              to?.attributes["work/blockage"] === true
            )
              throw new Fault("blockage", "Blockages cannot be parent-of work");
          }
        }
      }
    });

    ctx.subscribe((event) => {
      const affected = new Set<string>();
      for (const change of event.changes) {
        if (change.kind === "node") {
          if (this.isKanbanWork(change.after)) affected.add(change.after.id);
          if (
            change.after?.attributes["work/blockage"] === true ||
            change.before?.attributes["work/blockage"] === true
          )
            for (const edge of ctx.graph.edges(change.after?.id ?? change.before?.id, "blocks"))
              affected.add(edge.to_id);
        } else {
          const changedEdge = change.after ?? change.before;
          if (changedEdge?.relation === "blocks") affected.add(changedEdge.to_id);
          if (changedEdge?.relation === "parent-of") {
            affected.add(changedEdge.from_id);
            affected.add(changedEdge.to_id);
          }
        }
      }
      for (const id of affected) this.syncRelated(id);
    });
    ctx.resource({
      start: () => {
        for (const row of ctx.graph.all({ lean: false }))
          if (this.isKanbanWork(row)) this.sync(row.id);
      },
      stop() {},
    });
  }

  block(raw: z.input<typeof blockInput>): unknown {
    const input = blockInput.parse({ ...raw, byIdentity: raw.byIdentity ?? callerActor(this.ctx) });
    const actor = requireValue(input.byIdentity, "Supply --by-identity or BL_ACTOR");
    return this.ctx.graph.atomic(() => {
      const target = this.ownedActive(input.id);
      const record = this.ctx.graph.add({
        title: `Block ${target.id}`,
        attributes: {
          "work/blockage": true,
          "work/domain": "kanban",
          "work/reason": input.reason,
          "work/raised-by": actor,
          "work/needed-from": input.neededFrom ?? null,
          "work/raised-at": new Date(this.ctx.clock.now()).toISOString(),
        },
      });
      this.ctx.graph.connect(record.id, target.id, "blocks");
      attribute(this.ctx, record.id, actor, "attributed");
      if (input.neededFrom !== undefined)
        attribute(this.ctx, record.id, input.neededFrom, "attributed");
      return this.detail(record);
    }, this.authority);
  }

  unblock(raw: z.input<typeof unblockInput>): unknown {
    const input = unblockInput.parse({
      ...raw,
      byIdentity: raw.byIdentity ?? callerActor(this.ctx),
    });
    const actor = requireValue(input.byIdentity, "Supply --by-identity or BL_ACTOR");
    return this.ctx.graph.atomic(() => {
      const record = this.ctx.graph.show(input.id);
      if (
        record.attributes["work/blockage"] !== true ||
        record.attributes["work/domain"] !== "kanban"
      )
        throw new Fault("blockage", "Expected a Kanban blockage");
      if (record.state === "closed") {
        if (record.attributes["work/resolution"] !== input.resolution)
          throw new Fault("blockage", "Blockage was resolved differently");
        return this.detail(record);
      }
      const resolved = this.ctx.graph.update(record.id, {
        state: "closed",
        attributes: {
          "work/resolution": input.resolution,
          "work/resolved-by": actor,
          "work/resolved-at": new Date(this.ctx.clock.now()).toISOString(),
        },
      });
      attribute(this.ctx, record.id, actor, "attributed");
      return this.detail(resolved);
    }, this.authority);
  }

  effective(id: string): Node[] {
    return this.applicable(id).filter((row) => row.state === "active");
  }

  claimLane(id: string): void {
    this.ctx.graph.atomic(() => {
      const blocked = this.presentation(id).length > 0;
      this.ctx.graph.update(id, {
        attributes: blocked
          ? { "kanban/lane": "blocked", [this.bookmark]: "claimed" }
          : { "kanban/lane": "claimed" },
      });
    }, this.authority);
  }

  assertLaneChange(id: string): void {
    const blockages = this.presentationCompact(id);
    if (blockages.length > 0)
      throw new Fault("blocked", "Resolve visible blockages before changing lane", {
        id,
        blockages,
      });
  }

  private protectRemovedContainment(changes: readonly Mutation[]): void {
    const removedEdges = changes.flatMap((change) =>
      change.kind === "edge" && change.after === null && change.before?.relation === "parent-of"
        ? [change.before]
        : [],
    );

    for (const change of changes) {
      if (change.kind === "node" && change.before?.state === "active" && change.after === null) {
        const blockages = this.effectiveBeforeRemoval(change.before.id, removedEdges);
        if (blockages.length > 0)
          throw new Fault("blocked", "Resolve effective blockages before deleting active work", {
            id: change.before.id,
            blockages: blockages.map((row) => this.summary(row)),
          });
      }
      if (
        change.kind !== "edge" ||
        change.before?.relation !== "parent-of" ||
        change.after !== null
      )
        continue;
      const blockages = this.effectiveBeforeRemoval(change.before.to_id, [
        change.before,
        ...removedEdges,
      ]);
      if (blockages.length > 0)
        throw new Fault("blocked", "Resolve effective blockages before detaching work", {
          parent: change.before.from_id,
          child: change.before.to_id,
        });
    }
  }

  private effectiveBeforeRemoval(id: string, removedEdges: Edge[]): Node[] {
    const targets = new Set<string>([id]);
    const pending = [id];
    while (pending.length > 0) {
      const current = requireValue(pending.pop(), "Pending removed ancestor");
      const priorEdges = [...this.ctx.graph.edges(current, "parent-of"), ...removedEdges];
      for (const edge of priorEdges)
        if (edge.relation === "parent-of" && edge.to_id === current && !targets.has(edge.from_id)) {
          targets.add(edge.from_id);
          pending.push(edge.from_id);
        }
    }
    return this.blockageRecords().filter(
      (row) =>
        row.state === "active" &&
        this.ctx.graph.edges(row.id, "blocks").some((edge) => targets.has(edge.to_id)),
    );
  }

  private applicable(id: string): Node[] {
    const targets = new Set<string>([id]);
    const pending = [id];
    while (pending.length > 0) {
      const current = requireValue(pending.pop(), "Pending ancestor");
      for (const parentEdge of this.ctx.graph
        .edges(current, "parent-of")
        .filter((candidate) => candidate.to_id === current))
        if (!targets.has(parentEdge.from_id)) {
          targets.add(parentEdge.from_id);
          pending.push(parentEdge.from_id);
        }
    }
    return this.blockageRecords().filter((row) =>
      this.ctx.graph.edges(row.id, "blocks").some((edge) => targets.has(edge.to_id)),
    );
  }

  compact(id: string): BlockageSummary[] {
    return this.effective(id).map((row) => this.summary(row));
  }

  presentationCompact(id: string): BlockageSummary[] {
    return this.presentation(id).map((row) => this.summary(row));
  }

  details(id: string): unknown[] {
    return this.presentationHistory(id).map((row) => this.detail(row));
  }

  private presentation(id: string): Node[] {
    return this.presentationHistory(id).filter((row) => row.state === "active");
  }

  private presentationHistory(id: string): Node[] {
    const targets = new Set(this.ctx.graph.subgraph(id).nodes.map((row) => row.id));
    const records = new Map(this.applicable(id).map((row) => [row.id, row]));
    for (const row of this.blockageRecords())
      if (this.ctx.graph.edges(row.id, "blocks").some((edge) => targets.has(edge.to_id)))
        records.set(row.id, row);
    return [...records.values()];
  }

  private blockageRecords(): Node[] {
    return this.ctx.graph
      .all({ lean: false })
      .filter((row) => row.attributes["work/blockage"] === true);
  }

  private detail(row: Node): unknown {
    const needed = row.attributes["work/needed-from"];
    const resolution = row.attributes["work/resolution"];
    return {
      ...this.summary(row),
      raisedBy: attribution(this.ctx.graph, text.parse(row.attributes["work/raised-by"])),
      neededFrom: typeof needed === "string" ? attribution(this.ctx.graph, needed) : null,
      raisedAt: text.parse(row.attributes["work/raised-at"]),
      resolution:
        typeof resolution === "string"
          ? {
              text: resolution,
              by: attribution(this.ctx.graph, text.parse(row.attributes["work/resolved-by"])),
              at: text.parse(row.attributes["work/resolved-at"]),
            }
          : null,
    };
  }

  private summary(row: Node): BlockageSummary {
    const target = this.targetOf(row);
    return {
      id: row.id,
      domain: text.parse(row.attributes["work/domain"]),
      target,
      reason: text.parse(row.attributes["work/reason"]),
    };
  }

  private targetOf(row: Node): string {
    const edges = this.ctx.graph.edges(row.id, "blocks").filter((edge) => edge.from_id === row.id);
    if (edges.length !== 1) throw new Fault("blockage", "Blockage must retain exactly one target");
    return requireValue(edges[0], "Missing blockage target").to_id;
  }
  private ownedActive(id: string): Node {
    const row = this.ctx.graph.show(id);
    if (
      !this.isKanbanWork(row) ||
      row.state !== "active" ||
      row.attributes["kanban/link"] !== undefined
    )
      throw new Fault("blockage", "Expected owned active Kanban card or task");
    return row;
  }
  private isKanbanWork(row: Node | null | undefined): row is Node {
    return (
      row !== null &&
      row !== undefined &&
      (row.attributes["kanban/card"] === true || row.attributes["kanban/task"] === true)
    );
  }
  private syncRelated(id: string): void {
    this.syncTree(id);
    const seen = new Set<string>();
    const pending = [id];
    while (pending.length > 0) {
      const current = requireValue(pending.pop(), "Pending projection ancestor");
      if (seen.has(current)) continue;
      seen.add(current);
      const row = this.ctx.graph.all({ where: q.eq("id", current), lean: false })[0];
      if (this.isKanbanWork(row)) this.sync(current);
      for (const edge of this.ctx.graph
        .edges(current, "parent-of")
        .filter((candidate) => candidate.to_id === current))
        pending.push(edge.from_id);
    }
  }
  private syncTree(id: string): void {
    const seen = new Set<string>();
    const pending = [id];
    while (pending.length > 0) {
      const current = requireValue(pending.pop(), "Pending descendant");
      if (seen.has(current)) continue;
      seen.add(current);
      const row = this.ctx.graph.all({ where: q.eq("id", current), lean: false })[0];
      if (this.isKanbanWork(row)) this.sync(current);
      for (const childEdge of this.ctx.graph
        .edges(current, "parent-of")
        .filter((candidate) => candidate.from_id === current))
        pending.push(childEdge.to_id);
    }
  }
  private sync(id: string): void {
    this.ctx.graph.atomic(() => {
      const row = this.ctx.graph.show(id);
      if (
        row.state !== "active" ||
        row.attributes["kanban/card"] !== true ||
        row.attributes["kanban/link"] !== undefined
      )
        return;
      const blocked = this.presentation(id).length > 0;
      const previous = row.attributes[this.bookmark];
      if (blocked && previous === undefined)
        this.ctx.graph.update(id, {
          attributes: {
            "kanban/lane": "blocked",
            [this.bookmark]: text.parse(row.attributes["kanban/lane"]),
          },
        });
      else if (blocked && row.attributes["kanban/lane"] !== "blocked")
        this.ctx.graph.update(id, { attributes: { "kanban/lane": "blocked" } });
      else if (!blocked && previous !== undefined)
        this.ctx.graph.update(id, {
          attributes: { "kanban/lane": previous, [this.bookmark]: null },
        });
    }, this.authority);
  }
}
