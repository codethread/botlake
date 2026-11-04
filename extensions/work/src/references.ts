import { q, type Predicate } from "@botlake/core";

import { workAttributes } from "./node-model.ts";

/** Inert source selectors supplied explicitly to the References extension. */
export const workReferenceProjections: { kind: string; where: Predicate }[] = [
  {
    kind: "work/task",
    where: q.and(
      q.eq(q.attr(workAttributes.item), true),
      q.eq(q.attr(workAttributes.kind), "task"),
    ),
  },
  {
    kind: "work/group",
    where: q.and(
      q.eq(q.attr(workAttributes.item), true),
      q.eq(q.attr(workAttributes.kind), "group"),
    ),
  },
  {
    kind: "work/gate",
    where: q.and(
      q.eq(q.attr(workAttributes.item), true),
      q.eq(q.attr(workAttributes.kind), "gate"),
    ),
  },
];
