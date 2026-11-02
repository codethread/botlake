import { q, type Context, type Invocation, type Node } from "@botlake/core";
import { identityAttributes, resolveIdentity } from "@botlake/extension-identity";
import { audienceSchema, providerSchema, type Audience } from "@botlake/native-session";
import { z } from "zod";

import { agentAttributes } from "./node-model.ts";
import type { SessionContext } from "./prompt.ts";

const optionalMetadata = z.compile(z.string().trim().min(1).nullable().optional());
const observationSchema = z.compile(
  z.object({
    at: z.number().int(),
    audience: audienceSchema,
  }),
);

/** Resolve caller-owned metadata without registering or activating either extension. */
export function resolveSessionContext(ctx: Context, invocation: Invocation): SessionContext | null {
  if (invocation.identity === null) return null;

  const identity = resolveIdentity(ctx.graph, invocation.identity);
  if (identity === undefined) return null;

  return {
    provider: providerSchema.parse(identity.attributes[identityAttributes.provider]),
    audience: latestAudience(ctx, invocation.identity),
    model: metadata(identity, identityAttributes.model),
    effort: metadata(identity, identityAttributes.thinkingLevel),
    seat: metadata(identity, identityAttributes.agentSeat),
    cwd: invocation.cwd,
    workspace: ctx.workspace,
  };
}

function latestAudience(ctx: Context, identity: string): Audience {
  const observations = ctx.graph
    .all({
      where: q.and(
        q.eq(q.attr(agentAttributes.run), true),
        q.eq(q.attr(agentAttributes.identity), identity),
      ),
      includeArchived: true,
    })
    .flatMap((run) => {
      const value = run.attributes[agentAttributes.observation];
      return value === undefined || value === null
        ? []
        : [{ runId: run.id, observation: observationSchema.parse(value) }];
    });

  observations.sort((left, right) => {
    const timestampOrder = right.observation.at - left.observation.at;
    if (timestampOrder !== 0) return timestampOrder;
    if (left.runId === right.runId) return 0;
    return left.runId < right.runId ? 1 : -1;
  });
  return observations[0]?.observation.audience ?? "unknown";
}

function metadata(identity: Node, key: string): string | null {
  return optionalMetadata.parse(identity.attributes[key]) ?? null;
}
