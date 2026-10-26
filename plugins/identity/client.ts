import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, basename } from "node:path";

import { z } from "zod";

function execute(
  file: string,
  args: string[],
  options: { timeout?: number; maxBuffer?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error === null) resolve({ stdout, stderr });
      else reject(new Error(error.message, { cause: error }));
    });
  });
}
const bindingSchema = z.object({ identity: z.string(), instruction: z.string() });
export async function nativeProject(cwd: string): Promise<string | null> {
  let common: string;
  try {
    common = (
      await execute("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"])
    ).stdout.trim();
  } catch {
    return null;
  }
  if (basename(common) !== ".git") return null;
  const root = dirname(common);
  return existsSync(join(root, ".millstrand/config.json")) ? realpathSync(root) : null;
}
export async function strand(workspace: string, op: string, input: unknown): Promise<unknown> {
  const { stdout } = await execute(
    process.env["MILLSTRAND_STRAND_BIN"] ?? "strand",
    ["--workspace", workspace, "--input", JSON.stringify(input), op],
    { timeout: 8000, maxBuffer: 1024 * 1024 },
  );
  return JSON.parse(stdout);
}
export async function registerNative(input: {
  provider: "codex" | "pi" | "claude" | "cursor";
  nativeSessionId: string;
  cwd: string;
  unmanaged?: boolean;
  workspace?: string;
  parentIdentity?: string;
  model?: string;
  thinkingLevel?: string;
}): Promise<z.infer<typeof bindingSchema> | null> {
  const reference = input.unmanaged === true ? undefined : process.env["MILLSTRAND_RUN_REFERENCE"];
  const workspace =
    input.workspace === undefined
      ? reference === undefined
        ? await nativeProject(input.cwd)
        : realpathSync(z.string().min(1).parse(process.env["MILLSTRAND_WORKSPACE"]))
      : realpathSync(input.workspace);
  if (workspace === null) return null;
  const parts = reference?.split(":");
  if (parts !== undefined && (parts.length !== 2 || parts.some((part) => part.length === 0)))
    throw new Error("Malformed managed run reference");
  const { unmanaged: _, workspace: _workspace, ...request } = input;
  return bindingSchema.parse(
    await strand(workspace, "agent", {
      command: "native",
      ...request,
      ...(parts === undefined ? {} : { runId: parts[0], invocation: parts[1] }),
    }),
  );
}
