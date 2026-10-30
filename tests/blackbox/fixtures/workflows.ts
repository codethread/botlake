import { mkdir } from "node:fs/promises";
import { join } from "node:path";

/** Seed authored files, not engine-registered templates. Source is the unchanged Busybee example. */
export async function copyWorkflowExample(
  workspace: string,
  name: "parallel" | "nested-machines",
): Promise<string> {
  const directory = join(workspace, ".workflows", name);
  await mkdir(directory, { recursive: true });
  const source = new URL(import.meta.resolve(`@botlake/extension-workflow/examples/${name}`));
  const target = join(directory, "workflow.ts");
  await Bun.write(target, await Bun.file(source).text());
  await Bun.write(
    join(directory, "workflow.toml"),
    `version = "1.0.0"\ndescription = "Busybee ${name} example"\nrun = "workflow.ts"\n`,
  );
  return target;
}
