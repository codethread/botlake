import { Fault, jsonSchema, type Context, type Json } from "@botlake/core";

import { workStore } from "./store.ts";

export interface AbandonmentRequest {
  /** Work or cooperating-domain identity supplied by the caller. */
  id: string;
  /** Human explanation retained by every affected domain. */
  reason: string;
  /** Normalized invocation identity. */
  by: string;
}

export interface AbandonmentCooperation {
  /** Work root whose outstanding containment is terminally closed. */
  workId: string;
  /** Domain-specific terminalization details returned to the caller. */
  details: Json;
  /** Synchronous terminalization; joins Work closure in one graph transaction. */
  apply(): void;
}

/** Resolve scope without mutation; the returned apply joins terminal Work closure. */
export type AbandonmentProvider = (
  request: AbandonmentRequest,
) => AbandonmentCooperation | undefined;

const providers = new WeakMap<Context, AbandonmentProvider[]>();

/** Cooperative terminal abandonment shared by Work and workflow-facing aliases. */
export function workAbandonment(ctx: Context): {
  provide(provider: AbandonmentProvider): void;
  abandon(request: AbandonmentRequest): Json;
} {
  return {
    provide(provider) {
      const registered = providers.get(ctx) ?? [];
      registered.push(provider);
      providers.set(ctx, registered);
    },
    abandon(request) {
      return ctx.graph.atomic(() => {
        let cooperation: AbandonmentCooperation | undefined;
        for (const provider of providers.get(ctx) ?? []) {
          const candidate = provider(request);
          if (candidate === undefined) continue;
          if (cooperation !== undefined)
            throw new Fault(
              "work-abandonment",
              `Multiple domains claimed abandonment target ${request.id}`,
            );
          cooperation = candidate;
        }
        const workId = cooperation?.workId ?? request.id;
        cooperation?.apply();
        const result = workStore(ctx).abandon(workId, request.reason, request.by);
        return jsonSchema.parse({
          id: request.id,
          workId,
          state: "abandoned",
          ...result.abandonment,
          closed: {
            tasks: result.tasks,
            gates: result.gates,
            groups: result.groups,
          },
          cooperation: cooperation?.details ?? null,
        });
      });
    },
  };
}
