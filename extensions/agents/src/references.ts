import { q } from "@botlake/core";
import type { ReferenceProjection } from "@botlake/extension-references";

import { agentAttributes } from "./node-model.ts";

/** Inert source classification, selected explicitly on the shared reference library. */
export const agentReferenceProjections: ReferenceProjection[] = [
  { kind: "agent/run", where: q.eq(q.attr(agentAttributes.run), true) },
];
