import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";

function execute(
  file: string,
  args: string[],
  options: { timeout?: number; maxBuffer?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout) => {
      if (error === null) resolve(stdout);
      else reject(new Error(error.message, { cause: error }));
    });
  });
}

export async function nativeProject(cwd: string): Promise<string | null> {
  let common: string;
  try {
    common = (
      await execute("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"])
    ).trim();
  } catch {
    return null;
  }

  if (basename(common) !== ".git") return null;

  const root = dirname(common);
  return existsSync(join(root, ".botlake/package.json")) ? realpathSync(root) : null;
}

export async function bl(
  workspace: string,
  input: unknown,
  env: NodeJS.ProcessEnv,
): Promise<unknown> {
  const options = { timeout: 5000, maxBuffer: 1024 * 1024, env };
  try {
    await execute("botlake", ["lake", "status", "--workspace", workspace], options);
  } catch {
    await execute("botlake", ["lake", "start", "--workspace", workspace], options);
  }

  const stdout = await execute(
    env["BL_BIN"] ?? "bl",
    ["--workspace", workspace, "--input", JSON.stringify(input), "agent"],
    options,
  );

  return JSON.parse(stdout);
}
