import { join, resolve } from "node:path";

import type { system } from "../../tests/blackbox/fixtures/system.ts";

export const root = resolve(import.meta.dir, "../..");
export type Fixture = Awaited<ReturnType<typeof system>>;

export async function mailLake(
  fixture: Fixture,
  name: string,
  mode: "graph" | "linked" = "linked",
) {
  const workspace = await fixture.workspace(name, []);
  const extensions = [
    "@botlake/extension-batteries",
    "@botlake/extension-identity",
    "@botlake/extension-mail",
    ...(mode === "linked" ? ["@botlake/extension-mail-identity"] : []),
  ];
  await Bun.write(
    join(workspace, ".botlake/package.json"),
    JSON.stringify({ private: true, type: "module", botlake: { name, extensions } }),
  );
  await fixture.botlake(["lake", "start", "--workspace", workspace]);
  return workspace;
}

export function call(
  fixture: Fixture,
  workspace: string,
  identity: string,
  op: string,
  input: unknown,
) {
  return fixture.cli([
    "--workspace",
    workspace,
    "--identity",
    identity,
    "--input",
    JSON.stringify(input),
    op,
  ]);
}
