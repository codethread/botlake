import { Fault, q, requireValue, type Context, type Mutation, type Node } from "@botlake/core";
import { attribute, attribution, callerActor } from "@botlake/extension-identity";

export interface BlockageSummary {
  id: string;
  domain: string;
  target: string;
  reason: string;
}

export interface Attribution {
  identity: string;
  nodeIds: string[];
}

export interface BlockageDetail extends BlockageSummary {
  raisedBy: Attribution;
  neededFrom: Attribution | null;
  raisedAt: string;
  resolution: { text: string; by: Attribution; at: string } | null;
}

export function workflowBlockages(ctx: Context): {
  block(id: string, reason: string, neededFrom?: string, byIdentity?: string): BlockageDetail;
  unblock(id: string, resolution: string, byIdentity?: string): BlockageDetail;
  effective(id: string, detail?: boolean): BlockageSummary[] | BlockageDetail[];
  history(id: string): BlockageDetail[];
  assertUnblocked(id: string): void;
} {
  const authority = Symbol("workflow-blockages");
  const graph = ctx.graph;

  graph.protect((changes, token) => {
    for (const change of changes) {
      if (change.kind === "node") {
        const ownedBefore = isOwnedBlockage(change.before);
        const ownedAfter = isOwnedBlockage(change.after);
        if ((ownedBefore || ownedAfter) && token !== authority)
          throw new Fault(
            "workflow-blockage",
            "Workflow blockages require the Workflow blockage API",
          );
        if (isOwnedBlockage(change.after)) targetOf(change.after);

        if (change.before?.state === "active" && change.after?.state !== "active")
          assertBeforeUnblocked(change.before.id, changes);
        continue;
      }

      const edge = change.after ?? change.before;
      if (edge === null) continue;
      const from = finalNode(edge.from_id);
      const to = finalNode(edge.to_id);
      if (
        (edge.relation === "parent-of" || edge.relation === "depends-on") &&
        (isOwnedBlockage(from) || isOwnedBlockage(to))
      )
        throw new Fault(
          "workflow-blockage",
          "Workflow blockages cannot participate in work relations",
        );
      if (edge.relation === "blocks" && isOwnedBlockage(from) && token !== authority)
        throw new Fault("workflow-blockage", "Workflow blockage links are immutable");
      if (edge.relation === "parent-of" && change.after === null) {
        assertBeforeUnblocked(edge.to_id, changes);
      }
    }
  });

  function block(
    id: string,
    reason: string,
    neededFrom?: string,
    byIdentity?: string,
  ): BlockageDetail {
    const actor = requireValue(byIdentity ?? callerActor(ctx), "Supply identity or BL_ACTOR");
    return graph.atomic(() => {
      const target = graph.show(id);
      if (!isWorkflowWork(target) || target.state !== "active")
        throw new Fault("workflow-blockage", "Expected an active workflow run or task", { id });
      const record = graph.add({
        title: `Block ${target.id}`,
        attributes: {
          "work/blockage": true,
          "work/domain": "workflow",
          "work/reason": reason,
          "work/raised-by": actor,
          "work/needed-from": neededFrom ?? null,
          "work/raised-at": new Date(ctx.clock.now()).toISOString(),
        },
      });
      graph.connect(record.id, target.id, "blocks");
      attribute(ctx, record.id, actor, "attributed");
      if (neededFrom !== undefined) attribute(ctx, record.id, neededFrom, "attributed");
      return detailed(record);
    }, authority);
  }

  function unblock(id: string, resolution: string, byIdentity?: string): BlockageDetail {
    const actor = requireValue(byIdentity ?? callerActor(ctx), "Supply identity or BL_ACTOR");
    return graph.atomic(() => {
      const record = graph.show(id);
      if (!isOwnedBlockage(record))
        throw new Fault("workflow-blockage", "Expected a Workflow blockage", { id });
      if (record.state === "closed") {
        if (record.attributes["work/resolution"] !== resolution)
          throw new Fault("workflow-blockage", "Blockage was resolved differently", { id });
        return detailed(record);
      }
      const resolved = graph.update(id, {
        state: "closed",
        attributes: {
          "work/resolution": resolution,
          "work/resolved-by": actor,
          "work/resolved-at": new Date(ctx.clock.now()).toISOString(),
        },
      });
      attribute(ctx, id, actor, "attributed");
      return detailed(resolved);
    }, authority);
  }

  function effective(id: string, detail = false): BlockageSummary[] | BlockageDetail[] {
    graph.show(id);
    const applicable = applicableBlockages(id).filter((record) => record.state === "active");
    return detail
      ? applicable.map((record) => detailed(record))
      : applicable.map((record) => summary(record));
  }

  function history(id: string): BlockageDetail[] {
    graph.show(id);
    return applicableBlockages(id).map((record) => detailed(record));
  }

  function assertUnblocked(id: string): void {
    const blockages = effective(id);
    if (blockages.length > 0)
      throw new Fault("blocked", "Resolve effective blockages before closing workflow work", {
        id,
        blockages: blockages.map(({ id: blockageId, domain, target, reason }) => ({
          id: blockageId,
          domain,
          target,
          reason,
        })),
      });
  }

  return { block, unblock, effective, history, assertUnblocked };

  // -- Record interpretation and graph traversal --

  function assertBeforeUnblocked(id: string, changes: readonly Mutation[]): void {
    const records = applicableBlockages(id, changes).filter((record) => record.state === "active");
    if (records.length > 0)
      throw new Fault("blocked", "Resolve blockages before closing, detaching or deleting work", {
        id,
      });
  }

  function applicableBlockages(id: string, changes: readonly Mutation[] = []): Node[] {
    const targets = ancestorsOf(id, changes);
    return graph
      .all({ lean: false })
      .filter((record) => record.attributes["work/blockage"] === true)
      .filter(
        (record) =>
          graph
            .edges(record.id, "blocks")
            .some((edge) => edge.from_id === record.id && targets.has(edge.to_id)) ||
          changes.some(
            (change) =>
              change.kind === "edge" &&
              change.before?.relation === "blocks" &&
              change.before.from_id === record.id &&
              targets.has(change.before.to_id),
          ),
      );
  }

  function ancestorsOf(id: string, changes: readonly Mutation[]): Set<string> {
    const ancestors = new Set<string>();
    const pending = [id];
    while (pending.length > 0) {
      const current = pending.pop();
      if (current === undefined || ancestors.has(current)) continue;
      ancestors.add(current);
      for (const edge of graph.edges(current, "parent-of"))
        if (edge.to_id === current) pending.push(edge.from_id);
      for (const change of changes)
        if (
          change.kind === "edge" &&
          change.before?.relation === "parent-of" &&
          change.before.to_id === current
        )
          pending.push(change.before.from_id);
    }
    return ancestors;
  }

  function detailed(record: Node): BlockageDetail {
    const neededFrom = record.attributes["work/needed-from"];
    const resolution = record.attributes["work/resolution"];
    return {
      ...summary(record),
      raisedBy: attribution(graph, requiredText(record, "work/raised-by")),
      neededFrom: typeof neededFrom === "string" ? attribution(graph, neededFrom) : null,
      raisedAt: requiredText(record, "work/raised-at"),
      resolution:
        typeof resolution === "string"
          ? {
              text: resolution,
              by: attribution(graph, requiredText(record, "work/resolved-by")),
              at: requiredText(record, "work/resolved-at"),
            }
          : null,
    };
  }

  function summary(record: Node): BlockageSummary {
    return {
      id: record.id,
      domain: requiredText(record, "work/domain"),
      target: targetOf(record),
      reason: requiredText(record, "work/reason"),
    };
  }

  function targetOf(record: Node): string {
    const links = graph.edges(record.id, "blocks").filter((edge) => edge.from_id === record.id);
    if (links.length !== 1)
      throw new Fault("workflow-blockage", "Workflow blockage must retain exactly one target", {
        id: record.id,
      });
    return requireValue(links[0], "Workflow blockage target disappeared").to_id;
  }

  function finalNode(id: string): Node | undefined {
    return graph.all({ where: q.eq("id", id), lean: false })[0];
  }
}

function isOwnedBlockage(node: Node | null | undefined): node is Node {
  return (
    node?.attributes["work/blockage"] === true && node.attributes["work/domain"] === "workflow"
  );
}

function isWorkflowWork(node: Node | null | undefined): node is Node {
  return node?.attributes["workflow/root"] === true || node?.attributes["workflow/task"] === true;
}

function requiredText(node: Node, key: string): string {
  const value = node.attributes[key];
  if (typeof value !== "string")
    throw new Fault("workflow-blockage", `Expected ${key} on Workflow blockage`, { id: node.id });
  return value;
}
