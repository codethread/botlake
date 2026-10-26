import { test, expect } from "bun:test";
import { realpath, symlink } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { system } from "./fixtures/system.ts";

const row = z.object({
  id: z.string(),
  title: z.string(),
  attributes: z.record(z.string(), z.json()),
});
const view = z.object({
  card: row,
  link: z.object({ status: z.string(), snapshot: z.record(z.string(), z.json()).optional() }),
});

test("coordinator links use canonical workspace identity and preserve honest live and unavailable views", async () => {
  const host = await system();
  try {
    const spools = [
      "@millstrand/spool-batteries",
      "@millstrand/spool-identity",
      "@millstrand/spool-kanban",
    ];
    const coordinator = await host.workspace("board", spools);
    const downstream = await host.workspace("work", spools);
    for (const workspace of [coordinator, downstream])
      await host.mill(["weaver", "start", "--workspace", workspace]);

    for (const workspace of ["board", coordinator]) {
      expect(
        await host.strand(
          "board",
          "kanban",
          {
            command: "link",
            operation: "add",
            workspace,
            title: "Must not be created",
          },
          false,
        ),
      ).toContain("another workspace");
    }
    expect(await host.strand("board", "list", {})).toEqual([]);

    const card = row.parse(
      await host.strand("work", "kanban", { command: "add", title: "Original" }),
    );
    const task = row.parse(
      await host.strand("work", "kanban", {
        command: "task",
        feature: card.id,
        title: "Task",
      }),
    );
    expect(
      await host.strand(
        "board",
        "kanban",
        {
          command: "link",
          operation: "attach",
          workspace: "work",
          id: task.id,
        },
        false,
      ),
    ).toContain("Only active cards");

    const mirror = row.parse(
      await host.strand("board", "kanban", {
        command: "link",
        operation: "attach",
        workspace: "work",
        id: card.id,
      }),
    );
    const canonical = await realpath(downstream);
    expect(mirror.attributes["kanban/link"]).toEqual({ workspace: canonical, card: card.id });
    const alias = join(host.dir, "alias");
    await symlink(downstream, alias);
    for (const workspace of ["work", downstream, alias]) {
      expect(
        await host.strand(
          "board",
          "kanban",
          {
            command: "link",
            operation: "attach",
            workspace,
            id: card.id,
          },
          false,
        ),
      ).toContain("already linked");
    }

    await Bun.write(
      join(downstream, ".millstrand/config.json"),
      JSON.stringify({ name: "renamed", spools }),
    );
    await host.mill(["weaver", "restart", "--workspace", downstream]);
    await host.strand("renamed", "update", { id: card.id, title: "Live title" });
    const live = view.parse(
      await host.strand("board", "kanban", { command: "card", id: mirror.id }),
    );
    expect(live.link.status).toBe("live");
    expect(live.card.title).toBe("Live title");
    expect(row.parse(await host.strand("board", "show", { id: mirror.id })).title).toBe("Original");

    const created = row.parse(
      await host.strand("board", "kanban", {
        command: "link",
        operation: "add",
        workspace: "renamed",
        title: "Created downstream",
      }),
    );
    expect(created.attributes["kanban/link"]).toMatchObject({ workspace: canonical });
    const createdLink = z.object({ card: z.string() }).parse(created.attributes["kanban/link"]);
    expect(row.parse(await host.strand("renamed", "show", { id: createdLink.card })).title).toBe(
      "Created downstream",
    );

    await host.strand("board", "kanban", { command: "link", operation: "refresh", id: mirror.id });
    await host.mill(["weaver", "stop", "--workspace", "renamed"]);
    const unavailable = view.parse(
      await host.strand("board", "kanban", { command: "card", id: mirror.id }),
    );
    expect(unavailable.card.title).toBe("Live title");
    expect(unavailable.link.status).toBe("unavailable");
    expect(unavailable.link.snapshot).toMatchObject({ title: "Live title" });
    expect(unavailable.link.snapshot?.["observed-at"]).toBeString();
  } finally {
    await host.close();
  }
}, 60000);
