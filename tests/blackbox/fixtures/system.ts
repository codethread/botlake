import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const source = resolve(import.meta.dir, "../../..");

export async function install(path: string, dependencies: Record<string, string>): Promise<void> {
  await Bun.write(
    join(path, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies,
      // Bun's offline peer resolver needs tarball overrides for unpublished packages.
      overrides: Object.fromEntries(
        Object.entries(dependencies).filter(([name]) => name.startsWith("@botlake/")),
      ),
    }),
  );
  const child = Bun.spawn(["bun", "install", "--ignore-scripts", "--offline"], {
    cwd: path,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(error);
}

export async function system(): Promise<{
  dir: string;
  home: string;
  botlakeBin: string;
  blBin: string;
  env: Record<string, string | undefined>;
  packages: Record<string, string>;
  workspace(name: string, extensions: string[]): Promise<string>;
  botlake(args: string[], ok?: boolean): Promise<unknown>;
  bl(workspace: string, op: string, input: unknown, ok?: boolean): Promise<unknown>;
  cli(args: string[], ok?: boolean): Promise<unknown>;
  wire(request: unknown): Promise<string>;
  close(): Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "botlake-system-"));
  const home = join(dir, "botlake");
  const botlakeBin = join(dir, "botlake-bin");
  const blBin = join(dir, "bl-bin");
  async function pack(path: string, name: string): Promise<string> {
    const tarball = join(dir, `${name}.tgz`);
    const child = Bun.spawn(["bun", "pm", "pack", "--ignore-scripts", "--filename", tarball], {
      cwd: join(source, path),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    if (code !== 0) throw new Error(error);
    return `file:${tarball}`;
  }
  const core = await pack("packages/core", "core");
  const packages: Record<string, string> = { "@botlake/core": core };
  for (const name of ["batteries", "identity", "kanban", "cron", "flags", "harnesses"])
    packages[`@botlake/extension-${name}`] = await pack(`extensions/${name}`, name);
  packages["@botlake/identity"] = await pack("plugins/identity", "native-identity");
  const engine = join(dir, "engine");
  await install(engine, { "@botlake/core": core });
  const env = {
    ...process.env,
    BOTLAKE_HOME: home,
    BOTLAKE_CORE: join(engine, "node_modules/@botlake/core"),
    BOTLAKE_BL_BIN: blBin,
  };
  for (const [name, binary] of [
    ["botlake", botlakeBin],
    ["bl", blBin],
  ]) {
    const child = Bun.spawn(["go", "build", "-o", binary ?? "", `./cmd/${name ?? ""}`], {
      cwd: join(source, "cli"),
      env: { ...process.env, GOPROXY: "off" },
      stderr: "pipe",
    });
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    if (code !== 0) throw new Error(stderr);
  }
  const daemon = Bun.spawn([botlakeBin, "start"], { env, stdout: "pipe", stderr: "pipe" });
  const stderr = new Response(daemon.stderr).text();
  const reader = daemon.stdout.getReader();
  const first = await reader.read();
  reader.releaseLock();
  if (!new TextDecoder().decode(first.value).includes('"ready":true'))
    throw new Error(await stderr);
  async function run(binary: string, args: string[], ok = true): Promise<unknown> {
    const child = Bun.spawn([binary, ...args], { cwd: dir, env, stdout: "pipe", stderr: "pipe" });
    const [code, output, error] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (!ok) {
      if (code === 0) throw new Error(`Expected failure: ${args.join(" ")}`);
      return error;
    }
    if (code !== 0)
      throw new Error(
        `${args.join(" ")}: ${error}\n${await Bun.file(join(home, "host.log")).text()}`,
      );
    return JSON.parse(output);
  }
  return {
    dir,
    home,
    botlakeBin,
    blBin,
    env,
    packages,
    async workspace(name, extensions) {
      const path = join(dir, name);
      await mkdir(join(path, ".botlake"), { recursive: true });
      await Bun.write(
        join(path, ".botlake/package.json"),
        JSON.stringify({ private: true, type: "module", botlake: { name, extensions } }),
      );
      await install(path, { ...packages, zod: "^4.6.7" });
      return path;
    },
    botlake: (args, ok) => run(botlakeBin, args, ok),
    bl: (workspace, op, input, ok) =>
      run(blBin, ["--workspace", workspace, "--input", JSON.stringify(input), op], ok),
    cli: (args, ok) => run(blBin, args, ok),
    wire(request) {
      return new Promise((resolveResult, reject) => {
        const connection = createConnection({ path: join(home, "botlake.sock") });
        connection.setEncoding("utf8");
        let buffer = "";
        connection.setTimeout(5000, () => {
          connection.destroy(new Error("Wire response timed out"));
        });
        connection.on("connect", () => {
          connection.write(`${JSON.stringify(request)}\n`);
        });
        connection.on("data", (chunk: string) => {
          buffer += chunk;
        });
        connection.on("end", () => {
          resolveResult(buffer);
          connection.destroy();
        });
        connection.on("error", reject);
      });
    },
    async close() {
      const timeout = setTimeout(() => {
        daemon.kill("SIGKILL");
      }, 10000);
      try {
        await run(botlakeBin, ["stop"]);
        await daemon.exited;
      } finally {
        clearTimeout(timeout);
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}
