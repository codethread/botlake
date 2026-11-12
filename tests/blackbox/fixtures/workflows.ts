import { join } from "node:path";

/** Register explicitly imported workflow definitions through a local configured extension. */
export async function writeWorkflowExtension(
  workspace: string,
  modules: readonly string[],
): Promise<void> {
  const imports = modules.map(
    (specifier, index) =>
      `import { workflow as definition${index} } from ${JSON.stringify(specifier)};`,
  );
  const definitions = modules.map((_, index) => `definition${index}`).join(", ");
  const target = join(workspace, "workflow-extension.ts");
  await Bun.write(
    target,
    [
      'import { workflows } from "@botlake/extension-workflow";',
      ...imports,
      `export default workflows({ definitions: [${definitions}] });`,
      "",
    ].join("\n"),
  );
}
