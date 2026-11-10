import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

const registry = "https://registry.npmjs.org";
const root = resolve(import.meta.dirname, "..");
const packageDirectory = join(root, "extensions/ct-config");
const sourceRoot = `${root}${sep}`;
const expectedPeers = [
  "@botlake/core",
  "@botlake/extension-agents",
  "@botlake/extension-flags",
  "@botlake/extension-identity",
  "@botlake/extension-references",
  "@botlake/extension-work",
  "@botlake/extension-work-agents",
] as const;

const sourceManifest = manifest(
  JSON.parse(await readFile(join(packageDirectory, "package.json"), "utf8")),
);
assert.equal(sourceManifest.name, "ct-config");
const archive = join(root, `dist/private/ct-config-${sourceManifest.version}.tgz`);
assert.equal(sourceManifest.private, true);
assert.equal(sourceManifest.license, "MIT");
assert.deepEqual(sourceManifest.files, ["src", "README.md", "LICENSE"]);
assert.deepEqual(Object.keys(sourceManifest.peerDependencies), expectedPeers);
for (const range of Object.values(sourceManifest.peerDependencies))
  assert.equal(range, "workspace:^");

const entries = run("tar", ["-tzf", archive], root).trim().split("\n");
for (const asset of sourceManifest.files)
  assert.ok(
    entries.some((entry) => entry === `package/${asset}` || entry.startsWith(`package/${asset}/`)),
    `${archive} omits ${asset}`,
  );
assert.ok(
  entries.every((entry) => !entry.endsWith(".js")),
  "private archive must remain source-only",
);
const packedManifest = manifest(
  JSON.parse(run("tar", ["-xOf", archive, "package/package.json"], root)),
);
for (const [name, range] of Object.entries(packedManifest.peerDependencies)) {
  assert.match(range, /^\^\d+\.\d+\.\d+$/u, `${name} was not rewritten to a public range`);
  assert.ok(!range.includes("workspace:"), `${name} retains a workspace protocol`);
}

const workspace = await realpath(await mkdtemp("/tmp/botlake-ct-"));
const config = join(workspace, ".botlake");
const home = join(workspace, "home");
const bin = join(workspace, "bin");
let supervisor: ReturnType<typeof Bun.spawn> | undefined;
try {
  await mkdir(config);
  await mkdir(home);
  await mkdir(bin);
  const consumerArchive = join(config, "ct-config.tgz");
  await copyFile(archive, consumerArchive);
  const latest = Object.fromEntries(expectedPeers.map((name) => [name, "latest"]));
  await writeFile(
    join(config, "package.json"),
    `${JSON.stringify(
      {
        private: true,
        type: "module",
        dependencies: { ...latest, "ct-config": "file:./ct-config.tgz" },
        botlake: {
          name: "private-config-verification",
          extensions: [
            "./.botlake/references.ts",
            "./.botlake/flags.ts",
            "@botlake/extension-identity",
            "./.botlake/agents.ts",
            "./.botlake/priming.ts",
            "./.botlake/work.ts",
            "./.botlake/work-agents.ts",
          ],
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(config, "bunfig.toml"),
    `[install]\nregistry = "${registry}"\nlinker = "isolated"\nminimumReleaseAge = 604800\nminimumReleaseAgeExcludes = ${JSON.stringify([...expectedPeers, "@botlake/native-session"])}\n`,
  );
  const wrappers = {
    "references.ts": "references",
    "flags.ts": "flags",
    "agents.ts": "agents",
    "priming.ts": "priming",
    "work.ts": "work",
    "work-agents.ts": "workAgents",
  } as const;
  for (const [file, binding] of Object.entries(wrappers))
    await writeFile(join(config, file), `export { ${binding} as default } from "ct-config";\n`);

  run(
    "bun",
    ["install", "--ignore-scripts", "--no-cache", "--cache-dir", join(workspace, "cache")],
    config,
  );
  const installedRoot = join(config, "node_modules");
  const privatePackage = await realpath(join(installedRoot, "ct-config"));
  assert.ok(privatePackage.startsWith(`${installedRoot}${sep}`));
  assert.ok(!privatePackage.startsWith(sourceRoot));
  for (const file of ["index.ts", "roster.ts"])
    assert.equal(
      await readFile(join(privatePackage, "src", file), "utf8"),
      await readFile(join(packageDirectory, "src", file), "utf8"),
    );
  for (const peer of expectedPeers) {
    const installed = await realpath(join(installedRoot, ...peer.split("/")));
    assert.ok(
      installed.startsWith(`${installedRoot}${sep}`),
      `${peer} escaped consumer node_modules`,
    );
    assert.ok(!installed.startsWith(sourceRoot), `${peer} resolved into the source checkout`);
  }

  await writeFile(
    join(config, "verify-imports.ts"),
    `import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { agentPrimer, flags, priming, roster, rosterFlags, workAgents } from "ct-config";
const packageRoot = fileURLToPath(new URL("../package.json", import.meta.resolve("ct-config")));
assert.ok(packageRoot.includes("node_modules/ct-config/package.json"));
assert.ok(Object.keys(roster.aliases).length > 0);
assert.equal(rosterFlags.deepseek.name, "agents/deepseek");
assert.equal(rosterFlags.fable.name, "agents/fable");
assert.equal(typeof agentPrimer, "function");
assert.equal(flags.name, "flags");
assert.equal(priming.name, "@botlake/core/priming");
assert.equal(workAgents.name, "work-agents");
console.log(JSON.stringify({ packageRoot }));
`,
  );
  const importResult: unknown = JSON.parse(run("bun", ["verify-imports.ts"], config));
  assertRecord(importResult, "import result");
  const importedPackageRoot = importResult["packageRoot"];
  assert.ok(typeof importedPackageRoot === "string");
  assert.ok(importedPackageRoot.startsWith(`${privatePackage}${sep}`));

  run("go", ["build", "-o", join(bin, "botlake"), "./cmd/botlake"], join(root, "cli"));
  const core = await realpath(join(installedRoot, "@botlake/core"));
  const env = {
    ...process.env,
    BL_ACTOR: "private-config-verifier",
    BL_CORE: core,
    BL_HOME: home,
    BL_WORKSPACE: undefined,
    PATH: `${bin}:${process.env["PATH"] ?? ""}`,
  };
  const started = Bun.spawn([join(bin, "botlake"), "start"], {
    cwd: workspace,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  supervisor = started;
  await waitForSupervisor(started.stdout, started.stderr);
  run(join(bin, "botlake"), ["lake", "start", "--workspace", workspace], workspace, env);
  const info = lakeInfo(
    JSON.parse(
      run(join(bin, "botlake"), ["lake", "info", "--workspace", workspace], workspace, env),
    ),
  );
  assert.equal(info.extensions.length, 7);
  for (const extension of info.extensions) {
    assert.ok(
      extension.module.startsWith(`${config}${sep}`) ||
        extension.module === "@botlake/extension-identity",
    );
    assert.ok(extension.source.startsWith(`${installedRoot}${sep}`));
    assert.ok(extension.packageJson.startsWith(`${installedRoot}${sep}`));
    assert.ok(!extension.source.startsWith(sourceRoot));
  }
  run(join(bin, "botlake"), ["lake", "stop", "--workspace", workspace], workspace, env);
  run(join(bin, "botlake"), ["stop"], workspace, env);
  await supervisor.exited;
  supervisor = undefined;

  const integrity = `sha512-${createHash("sha512")
    .update(await readFile(archive))
    .digest("base64")}`;
  console.log(
    JSON.stringify({
      archive,
      integrity,
      packedPeerDependencies: packedManifest.peerDependencies,
      privatePackage,
      publicPackages: expectedPeers.map((name) => join(installedRoot, ...name.split("/"))),
      activatedExtensions: info.extensions,
    }),
  );
} finally {
  if (supervisor !== undefined) {
    supervisor.kill("SIGTERM");
    await supervisor.exited;
  }
  await rm(workspace, { recursive: true, force: true });
}

interface Manifest {
  name: string;
  version: string;
  private: boolean;
  license: string;
  files: string[];
  peerDependencies: Record<string, string>;
}

function manifest(value: unknown): Manifest {
  assertRecord(value, "package manifest");
  const { name, version, private: isPrivate, license, files, peerDependencies } = value;
  assert.ok(typeof name === "string" && name.length > 0);
  assert.ok(typeof version === "string" && version.length > 0);
  assert.ok(typeof isPrivate === "boolean");
  assert.ok(typeof license === "string" && license.length > 0);
  assert.ok(Array.isArray(files) && files.every((entry) => typeof entry === "string"));
  assertRecord(peerDependencies, "peerDependencies");
  const peers: Record<string, string> = {};
  for (const [peer, range] of Object.entries(peerDependencies)) {
    assert.ok(typeof range === "string");
    peers[peer] = range;
  }
  return { name, version, private: isPrivate, license, files, peerDependencies: peers };
}

function lakeInfo(value: unknown): {
  extensions: Array<{ module: string; source: string; packageJson: string }>;
} {
  assertRecord(value, "lake info");
  const extensions = value["extensions"];
  assert.ok(Array.isArray(extensions));
  return {
    extensions: extensions.map((extension) => {
      assertRecord(extension, "extension metadata");
      const module = extension["module"];
      const source = extension["source"];
      const packageJson = extension["packageJson"];
      assert.ok(typeof module === "string");
      assert.ok(typeof source === "string");
      assert.ok(typeof packageJson === "string");
      return { module, source, packageJson };
    }),
  };
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object`,
  );
}

function run(
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const child = Bun.spawnSync([command, ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
  const stdout = new TextDecoder().decode(child.stdout);
  const stderr = new TextDecoder().decode(child.stderr);
  if (child.exitCode !== 0)
    throw new Error(`${command} ${args.join(" ")} failed:\n${stderr}${stdout}`);
  return stdout;
}

async function waitForSupervisor(
  stdout: ReadableStream<Uint8Array>,
  stderr: ReadableStream<Uint8Array>,
): Promise<void> {
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let output = "";
  while (true) {
    const next = await reader.read();
    if (next.done) {
      const errorOutput = await new Response(stderr).text();
      throw new Error(`Supervisor exited before readiness: ${output}${errorOutput}`);
    }
    output += decoder.decode(next.value, { stream: true });
    if (output.includes('"ready":true')) {
      reader.releaseLock();
      return;
    }
  }
}
