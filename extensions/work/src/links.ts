import { Fault, isFault, type Context, type Node, type Reference } from "@botlake/core";
import type { References } from "@botlake/extension-references";

import type { WorkLinkRelation } from "./node-model.ts";
import { workStore } from "./store.ts";

export interface WorkLink {
  /** Locally owned dependent or referencing work item. */
  from: string;
  /** Local endpoint, or source node ID when toWorkspace is supplied. */
  to: string;
  /** Prerequisite or non-contextual relationship. */
  relation: WorkLinkRelation;
  /** Owning lake of the source endpoint; omitted means a local ID. */
  toWorkspace?: string | undefined;
}

export interface WorkLinkResult {
  /** Locally owned source work item. */
  from: string;
  /** Local endpoint ID, including the imported reference for a remote endpoint. */
  to: string;
  /** Requested relationship. */
  relation: WorkLinkRelation;
  /** Whether the edge is present after this operation. */
  linked: boolean;
  /** Source provenance when the endpoint is a reference. */
  reference: Reference | null;
}

/** Domain links over local work and explicitly configured cross-lake references. */
export function workLinks(ctx: Context, references?: References) {
  const store = workStore(ctx);

  async function link(input: WorkLink, signal: AbortSignal): Promise<WorkLinkResult> {
    signal.throwIfAborted();
    store.get(input.from);
    const target =
      input.toWorkspace === undefined
        ? ctx.graph.show(input.to)
        : await library().follow(
            { workspace: input.toWorkspace, nodeId: input.to },
            signal,
            input.relation === "depends-on"
              ? { kinds: ["work/task", "work/group", "work/gate"] }
              : undefined,
          );
    try {
      signal.throwIfAborted();
      store.link(input.from, target.id, input.relation);
    } catch (error) {
      if (input.toWorkspace === undefined) throw error;
      throw new Fault(
        isFault(error) ? error.code : "work-link",
        error instanceof Error ? error.message : String(error),
        {
          linked: false,
          reference: {
            id: target.id,
            source: target.reference === null ? null : { ...target.reference },
          },
          cause: isFault(error) ? error.details : null,
        },
      );
    }
    return {
      from: input.from,
      to: target.id,
      relation: input.relation,
      linked: true,
      reference: target.reference,
    };
  }

  async function unlink(input: WorkLink, signal: AbortSignal): Promise<WorkLinkResult> {
    signal.throwIfAborted();
    store.get(input.from);
    let target: Node;
    if (input.toWorkspace === undefined) target = ctx.graph.show(input.to);
    else {
      const imported = await library().lookup(
        { workspace: input.toWorkspace, nodeId: input.to },
        signal,
      );
      if (imported === null)
        throw new Fault("work-link", "No local reference exists for this remote endpoint", {
          workspace: input.toWorkspace,
          nodeId: input.to,
        });
      target = imported;
    }
    signal.throwIfAborted();
    store.unlink(input.from, target.id, input.relation);
    return {
      from: input.from,
      to: target.id,
      relation: input.relation,
      linked: false,
      reference: target.reference,
    };
  }

  function library(): References {
    if (references === undefined)
      throw new Fault(
        "reference-library",
        "Configure Work with an explicitly selected reference library to use --to-workspace",
      );
    return references;
  }

  return { link, unlink };
}
