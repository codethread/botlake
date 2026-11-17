import { execFile } from "node:child_process";

export async function bl(
  workspace: string,
  input: unknown,
  env: NodeJS.ProcessEnv,
  identity: string,
): Promise<unknown> {
  const options = { timeout: 5000, maxBuffer: 1024 * 1024, env };
  try {
    await execute("botlake", ["lake", "status", "--workspace", workspace], options);
  } catch {
    await execute("botlake", ["lake", "start", "--workspace", workspace], options);
  }

  const stdout = await execute(
    env["BL_BIN"] ?? "bl",
    ["--workspace", workspace, "--identity", identity, "--input", JSON.stringify(input), "agent"],
    options,
  );

  return JSON.parse(stdout);
}

// -- Private helpers --

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
