import { join, resolve } from "node:path";

import type { system } from "../../tests/blackbox/fixtures/system.ts";

export const root = resolve(import.meta.dir, "../..");
export type Fixture = Awaited<ReturnType<typeof system>>;

export async function mailLake(
  fixture: Fixture,
  name: string,
  mode: "table" | "graph" | "linked" = "linked",
) {
  const workspace = await fixture.workspace(name, []);
  const source = mode === "table" ? "/Users/ct/dev/worktrees/botlake-mail-poc" : root;
  await Bun.write(
    join(workspace, ".botlake/mail.ts"),
    `import {mail} from ${JSON.stringify(join(source, "extensions/mail/src/index.ts"))}; export default mail();`,
  );
  const extensions = [
    "@botlake/extension-batteries",
    "@botlake/extension-identity",
    "./.botlake/mail.ts",
  ];
  if (mode === "linked") {
    await Bun.write(
      join(workspace, ".botlake/mail-identity.ts"),
      `import {mailIdentity} from ${JSON.stringify(join(root, "extensions/mail-identity/src/index.ts"))}; export default mailIdentity();`,
    );
    extensions.push("./.botlake/mail-identity.ts");
  }
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
