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
        Object.entries(dependencies).filter(([name]) => name.startsWith("@millstrand/")),
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
  millBin: string;
  strandBin: string;
  env: Record<string, string | undefined>;
  packages: Record<string, string>;
  workspace(name: string, spools: string[]): Promise<string>;
  mill(args: string[], ok?: boolean): Promise<unknown>;
  strand(workspace: string, op: string, input: unknown, ok?: boolean): Promise<unknown>;
  cli(args: string[], ok?: boolean): Promise<unknown>;
  wire(request: unknown): Promise<string>;
  close(): Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "mill-system-"));
  const home = join(dir, "mill");
  const millBin = join(dir, "mill-bin");
  const strandBin = join(dir, "strand-bin");
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
  const packages: Record<string, string> = { "@millstrand/core": core };
  for (const name of ["batteries", "identity", "kanban", "cron", "harnesses"])
    packages[`@millstrand/spool-${name}`] = await pack(`spools/${name}`, name);
  packages["@millstrand/identity"] = await pack("plugins/identity", "native-identity");
  const engine = join(dir, "engine");
  await install(engine, { "@millstrand/core": core });
  const env = {
    ...process.env,
    MILL_HOME: home,
    MILLSTRAND_CORE: join(engine, "node_modules/@millstrand/core"),
    MILLSTRAND_STRAND_BIN: strandBin,
  };
  for (const [name, binary] of [
    ["mill", millBin],
    ["strand", strandBin],
  ]) {
    const child = Bun.spawn(["go", "build", "-o", binary ?? "", `./cmd/${name ?? ""}`], {
      cwd: join(source, "cli"),
      env: { ...process.env, GOPROXY: "off" },
      stderr: "pipe",
    });
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    if (code !== 0) throw new Error(stderr);
  }
  const daemon = Bun.spawn([millBin, "start"], { env, stdout: "pipe", stderr: "pipe" });
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
    millBin,
    strandBin,
    env,
    packages,
    async workspace(name, spools) {
      const path = join(dir, name);
      await mkdir(join(path, ".millstrand"), { recursive: true });
      await Bun.write(join(path, ".millstrand/config.json"), JSON.stringify({ name, spools }));
      await install(path, { ...packages, zod: "^4.6.7" });
      return path;
    },
    mill: (args, ok) => run(millBin, args, ok),
    strand: (workspace, op, input, ok) =>
      run(strandBin, ["--workspace", workspace, "--input", JSON.stringify(input), op], ok),
    cli: (args, ok) => run(strandBin, args, ok),
    wire(request) {
      return new Promise((resolveResult, reject) => {
        const connection = createConnection({ path: join(home, "mill.sock") });
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
        await run(millBin, ["stop"]);
        await daemon.exited;
      } finally {
        clearTimeout(timeout);
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}
