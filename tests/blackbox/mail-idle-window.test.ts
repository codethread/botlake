import { expect, test } from "bun:test";
import { join } from "node:path";

import { system } from "./fixtures/system.ts";

test("mail idle windows default and vary by provider, including disabled", async () => {
  const host = await system();
  try {
    const lake = await host.workspace("idle-windows", ["./configured-mail.ts"]);
    await Bun.write(
      join(lake, "configured-mail.ts"),
      `import { mail } from "@botlake/extension-mail";
export default mail({ idleWake: { defaultSecs: 600, byProvider: { pi: 1, claude: 0, codex: 12 * 3600 } } });\n`,
    );
    await host.botlake(["lake", "start", "--workspace", lake]);
    for (const [provider, seconds] of [
      ["other", 600],
      ["codex", 43200],
      ["pi", 1],
      ["claude", 0],
    ] as const) {
      expect(await host.bl(lake, "mail", { command: "idle-window", provider })).toEqual({
        seconds,
      });
    }
    const defaults = await host.workspace("default-window", ["@botlake/extension-mail"]);
    await host.botlake(["lake", "start", "--workspace", defaults]);
    expect(await host.bl(defaults, "mail", { command: "idle-window", provider: "pi" })).toEqual({
      seconds: 300,
    });
  } finally {
    await host.close();
  }
}, 60000);
