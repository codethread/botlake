# @millstrand/spool-cron

Durable calendar/interval jobs and occurrence history. Requires the `@millstrand/core` peer package; no prerequisite spools. `cron-parser` is owned by this package, not core.

Select a local module exporting a configured Cron spool:

```ts
import { cron, defineJob } from "@millstrand/spool-cron";

export default cron({
  jobs: [defineJob({ id: "tick", action: "tick", schedule: { everyMs: 60000 } })],
  actions: {
    tick: (ctx, occurrence) => {
      ctx.graph.add({ title: occurrence.id });
    },
  },
});
```

Schedules accept `everyMs` or `expression` with an IANA `timezone`. Jobs declare overlap (`skip`, `queue`, `allow`), missed-run (`skip`, `once`, `catch-up`) and retry policies. Unchanged definitions retain cadence; changes reset it. Actions receive stable occurrence IDs for deduplicating external effects under at-least-once delivery.

`defineJob`, `Cron`, `nextFire`, job/action types and `jobJsonSchema()` are public exports. The default export is an inert Cron spool with no jobs/actions, useful for status/history. Core's durable wake scheduler remains separate from Cron's job model.
