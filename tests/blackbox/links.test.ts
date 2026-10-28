import { test, expect } from "bun:test";
import { realpath, symlink } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { system } from "./fixtures/system.ts";

const row = z.compile(
  z.object({
    id: z.string(),
    title: z.string(),
    attributes: z.record(z.string(), z.json()),
  }),
);
const view = z.compile(
  z.object({
    card: row,
    link: z.object({ status: z.string(), snapshot: z.record(z.string(), z.json()).optional() }),
  }),
);
const linkCard = z.compile(z.object({ card: z.string() }));

test("coordinator links use canonical workspace identity and preserve honest live and unavailable views", async () => {
  const host = await system();
  try {
    const extensions = [
      "@botlake/extension-batteries",
      "@botlake/extension-identity",
      "@botlake/extension-kanban",
    ];
    const coordinator = await host.workspace("board", extensions);
    const downstream = await host.workspace("work", extensions);
    for (const workspace of [coordinator, downstream])
      await host.botlake(["lake", "start", "--workspace", workspace]);

    for (const workspace of ["board", coordinator]) {
      expect(
        await host.bl(
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
    expect(await host.bl("board", "list", {})).toEqual([]);

    const card = row.parse(await host.bl("work", "kanban", { command: "add", title: "Original" }));
    const task = row.parse(
      await host.bl("work", "kanban", {
        command: "task",
        feature: card.id,
        title: "Task",
      }),
    );
    expect(
      await host.bl(
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
      await host.bl("board", "kanban", {
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
        await host.bl(
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
      join(downstream, ".botlake/package.json"),
      JSON.stringify({ botlake: { name: "renamed", extensions } }),
    );
    await host.botlake(["lake", "restart", "--workspace", downstream]);
    await host.bl("renamed", "update", { id: card.id, title: "Live title" });
    const live = view.parse(await host.bl("board", "kanban", { command: "card", id: mirror.id }));
    expect(live.link.status).toBe("live");
    expect(live.card.title).toBe("Live title");
    expect(row.parse(await host.bl("board", "show", { id: mirror.id })).title).toBe("Original");

    const created = row.parse(
      await host.bl("board", "kanban", {
        command: "link",
        operation: "add",
        workspace: "renamed",
        title: "Created downstream",
      }),
    );
    expect(created.attributes["kanban/link"]).toMatchObject({ workspace: canonical });
    const createdLink = linkCard.parse(created.attributes["kanban/link"]);
    expect(row.parse(await host.bl("renamed", "show", { id: createdLink.card })).title).toBe(
      "Created downstream",
    );

    await host.bl("board", "kanban", { command: "link", operation: "refresh", id: mirror.id });
    await host.botlake(["lake", "stop", "--workspace", "renamed"]);
    const unavailable = view.parse(
      await host.bl("board", "kanban", { command: "card", id: mirror.id }),
    );
    expect(unavailable.card.title).toBe("Live title");
    expect(unavailable.link.status).toBe("unavailable");
    expect(unavailable.link.snapshot).toMatchObject({ title: "Live title" });
    expect(unavailable.link.snapshot?.["observed-at"]).toBeString();
  } finally {
    await host.close();
  }
}, 60000);
