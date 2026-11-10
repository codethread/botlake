import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { parseArgs } from "node:util";

const registry = "https://registry.npmjs.org";
const root = resolve(import.meta.dirname, "..");
const publicPackages = [
  { directory: "packages/core", assets: ["src", "README.md", "LICENSE", "NOTICE"] },
  { directory: "packages/native-session", assets: ["src", "README.md", "LICENSE"] },
  { directory: "extensions/agents", assets: ["src", "README.md", "LICENSE"] },
  { directory: "extensions/batteries", assets: ["src", "README.md", "LICENSE"] },
  { directory: "extensions/cron", assets: ["src", "README.md", "LICENSE"] },
  { directory: "extensions/diary", assets: ["src", "README.md", "LICENSE"] },
  { directory: "extensions/flags", assets: ["src", "README.md", "LICENSE"] },
  { directory: "extensions/identity", assets: ["src", "README.md", "LICENSE"] },
  { directory: "extensions/references", assets: ["src", "README.md", "LICENSE"] },
  { directory: "extensions/work", assets: ["src", "README.md", "LICENSE"] },
  { directory: "extensions/work-agents", assets: ["src", "README.md", "LICENSE"] },
  { directory: "extensions/work-auto-bot", assets: ["src", "README.md", "LICENSE"] },
  {
    directory: "extensions/workflow",
    assets: ["src", "examples", "README.md", "LICENSE"],
  },
] as const;
const excludedPackages = [
  { directory: ".", name: "botlake", reason: "private workspace root" },
  { directory: ".botlake", name: "@botlake/dogfood", reason: "private dogfood lake" },
  {
    directory: "extensions/ct-config",
    name: "ct-config",
    reason: "private operator configuration",
  },
  {
    directory: "plugins/identity",
    name: "@botlake/identity",
    reason: "harness adapters supplied from the repository-local plugin marketplace",
  },
] as const;
interface PackageMetadata {
  name: string;
  license: "MIT";
  private?: boolean;
  publishConfig?: { access: "public" };
}

interface PublicManifest extends PackageMetadata {
  version: string;
  files: string[];
}

interface RegistryMetadata {
  name: string;
  version: string;
  license: "MIT";
  dist: { integrity: string };
}
const { values } = parseArgs({
  options: {
    packed: { type: "boolean", default: false },
    archives: { type: "string", default: "dist/release" },
    help: { type: "boolean", short: "h", default: false },
  },
});
if (values.help) {
  console.log(`Usage: bun scripts/verify-release.ts [--packed] [--archives DIR]

Verify every public Botlake runtime package, its archive contents, a fresh consumer
install and disposable SQLite operation. Default mode checks exact versions on npm
before installing them. --packed installs the locally packed archives instead.

Published mode reports all available and unavailable artifacts together, then exits
without publishing or attempting duplicate publication when the release is partial.
The archive directory defaults to dist/release.`);
  process.exit(0);
}

const archives = resolve(root, values.archives);
const license = await readFile(join(root, "LICENSE"), "utf8");
const packages = await Promise.all(
  publicPackages.map(async ({ directory, assets }) => {
    const path = join(root, directory);
    const manifest = publicManifest(JSON.parse(await readFile(join(path, "package.json"), "utf8")));
    assert.equal(manifest.private, undefined, `${manifest.name} must remain public`);
    assert.deepEqual(manifest.publishConfig, { access: "public" });
    assert.deepEqual(manifest.files, assets);
    assert.equal(await readFile(join(path, "LICENSE"), "utf8"), license);
    const archive = join(archives, archiveName(manifest.name, manifest.version));
    const integrity = `sha512-${createHash("sha512")
      .update(await readFile(archive))
      .digest("base64")}`;
    const entries = listArchive(archive);
    for (const asset of assets)
      assert.ok(
        entries.some(
          (entry) => entry === `package/${asset}` || entry.startsWith(`package/${asset}/`),
        ),
        `${archive} omits ${asset}`,
      );
    assert.ok(
      !entries.some((entry) => entry.includes(".botlake") || entry.includes("plugins/identity")),
      `${archive} contains private or harness-only files`,
    );
    return { directory, assets, manifest, archive, integrity };
  }),
);

for (const excluded of excludedPackages) {
  const path = excluded.directory === "." ? root : join(root, excluded.directory);
  const manifest = packageMetadata(JSON.parse(await readFile(join(path, "package.json"), "utf8")));
  assert.equal(manifest.name, excluded.name);
  assert.equal(manifest.private, true, `${excluded.name} must stay out of npm release scope`);
  assert.equal(
    manifest.publishConfig,
    undefined,
    `${excluded.name} must not advertise publication`,
  );
}

if (!values.packed) {
  const availability = await Promise.all(
    packages.map(async (item) => {
      const specifier = `${item.manifest.name}@${item.manifest.version}`;
      const response = await fetch(
        `${registry}/${encodeURIComponent(item.manifest.name)}/${item.manifest.version}`,
      );
      if (response.status === 404)
        return { status: "unavailable" as const, specifier, archive: item.archive };
      if (!response.ok)
        throw new Error(
          `Registry lookup failed for ${specifier}: ${response.status} ${response.statusText}`,
        );
      const published = registryMetadata(await response.json());
      assert.equal(published.name, item.manifest.name);
      assert.equal(published.version, item.manifest.version);
      assert.equal(
        published.dist.integrity,
        item.integrity,
        `${specifier} differs from the checked archive`,
      );
      return {
        status: "available" as const,
        specifier,
        archive: item.archive,
        integrity: item.integrity,
      };
    }),
  );
  const available = availability.filter((item) => item.status === "available");
  const unavailable = availability.filter((item) => item.status === "unavailable");
  if (unavailable.length > 0) {
    console.error(JSON.stringify({ status: "partial", available, unavailable }, null, 2));
    process.exit(1);
  }
}

const workspace = await realpath(await mkdtemp(join(tmpdir(), "botlake-release-")));
const config = join(workspace, ".botlake");
const home = join(workspace, "home");
const bin = join(workspace, "bin");
let supervisor: ReturnType<typeof Bun.spawn> | undefined;
try {
  await mkdir(config);
  await mkdir(home);
  await mkdir(bin);
  const dependencies = Object.fromEntries(
    packages.map(({ manifest, archive }) => [
      manifest.name,
      values.packed ? `file:${archive}` : manifest.version,
    ]),
  );
  await writeFile(
    join(config, "package.json"),
    `${JSON.stringify(
      {
        private: true,
        type: "module",
        dependencies,
        overrides: dependencies,
        botlake: { name: "release-verification", extensions: ["@botlake/extension-batteries"] },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(config, "bunfig.toml"),
    `[install]\nlinker = "isolated"\nminimumReleaseAgeExcludes = ${JSON.stringify(packages.map(({ manifest }) => manifest.name))}\n`,
  );
  run(
    "bun",
    [
      "install",
      "--ignore-scripts",
      "--no-cache",
      "--cache-dir",
      join(workspace, "cache"),
      "--registry",
      registry,
    ],
    config,
  );

  const installedRoot = join(config, "node_modules");
  for (const { assets, manifest } of packages) {
    const installed = join(installedRoot, ...manifest.name.split("/"));
    const installedManifest = publicManifest(
      JSON.parse(await readFile(join(installed, "package.json"), "utf8")),
    );
    assert.equal(installedManifest.version, manifest.version);
    assert.equal(await readFile(join(installed, "LICENSE"), "utf8"), license);
    for (const asset of assets) await realpath(join(installed, asset));
  }

  const imports = packages
    .map(({ manifest }) => `import ${JSON.stringify(manifest.name)};`)
    .join("\n");
  run("bun", ["--eval", imports], config);
  run("go", ["build", "-o", join(bin, "botlake"), "./cmd/botlake"], join(root, "cli"));
  run("go", ["build", "-o", join(bin, "bl"), "./cmd/bl"], join(root, "cli"));

  const core = join(installedRoot, "@botlake/core");
  const env = {
    ...process.env,
    BL_ACTOR: "release-verifier",
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
  await waitForSupervisor(started.stdout);
  run(join(bin, "botlake"), ["lake", "start", "--workspace", workspace], workspace, env);
  const info = lakeInfo(
    JSON.parse(
      run(join(bin, "botlake"), ["lake", "info", "--workspace", workspace], workspace, env),
    ),
  );
  assert.ok(info.packageJson.startsWith(`${config}${sep}`));
  assert.equal(info.extensions.length, 1);
  const extension = info.extensions[0];
  assert.ok(extension !== undefined);
  for (const path of [extension.module, extension.source, extension.packageJson]) {
    assert.ok(
      path.startsWith(`${installedRoot}${sep}`),
      `Lake resolved outside the fresh consumer: ${path}`,
    );
  }
  const created = nodeResult(
    JSON.parse(
      run(
        join(bin, "bl"),
        ["--workspace", workspace, "node", "add", "Release archive smoke"],
        workspace,
        env,
      ),
    ),
  );
  const shown = nodeResult(
    JSON.parse(
      run(join(bin, "bl"), ["--workspace", workspace, "node", "show", created.id], workspace, env),
    ),
  );
  assert.equal(shown.title, "Release archive smoke");
  await realpath(join(config, "world.db"));
  run(join(bin, "botlake"), ["lake", "stop", "--workspace", workspace], workspace, env);
  run(join(bin, "botlake"), ["stop"], workspace, env);
  await supervisor.exited;
  supervisor = undefined;

  console.log(
    JSON.stringify({
      verified: packages.map(
        ({ manifest, integrity }) => `${manifest.name}@${manifest.version} ${integrity}`,
      ),
      source: values.packed ? "packed" : "npm",
      core,
      sqlite: join(config, "world.db"),
      excluded: excludedPackages,
    }),
  );
} finally {
  if (supervisor !== undefined) {
    supervisor.kill("SIGTERM");
    await supervisor.exited;
  }
  await rm(workspace, { recursive: true, force: true });
}

function packageMetadata(value: unknown): PackageMetadata {
  assertRecord(value, "package metadata");
  const name = value["name"];
  const licenseValue = value["license"];
  const privateValue = value["private"];
  const publishConfigValue = value["publishConfig"];
  assertNonEmptyString(name, "package name");
  assert.equal(licenseValue, "MIT", `${name} must declare MIT`);
  if (privateValue !== undefined) assert.equal(typeof privateValue, "boolean");
  let publishConfig: PackageMetadata["publishConfig"];
  if (publishConfigValue !== undefined) {
    assertRecord(publishConfigValue, `${name} publishConfig`);
    assert.equal(publishConfigValue["access"], "public");
    publishConfig = { access: "public" };
  }
  return {
    name,
    license: "MIT",
    ...(typeof privateValue === "boolean" ? { private: privateValue } : {}),
    ...(publishConfig === undefined ? {} : { publishConfig }),
  };
}

function publicManifest(value: unknown): PublicManifest {
  const metadata = packageMetadata(value);
  assertRecord(value, `${metadata.name} manifest`);
  const version = value["version"];
  const files = value["files"];
  assertNonEmptyString(version, `${metadata.name} version`);
  assert.ok(
    Array.isArray(files) && files.every((entry) => typeof entry === "string"),
    `${metadata.name} files must be strings`,
  );
  return { ...metadata, version, files };
}

function registryMetadata(value: unknown): RegistryMetadata {
  const metadata = packageMetadata(value);
  assertRecord(value, `${metadata.name} registry metadata`);
  const version = value["version"];
  const dist = value["dist"];
  assertNonEmptyString(version, `${metadata.name} registry version`);
  assertRecord(dist, `${metadata.name} dist`);
  const integrity = dist["integrity"];
  assertNonEmptyString(integrity, `${metadata.name} integrity`);
  return {
    name: metadata.name,
    version,
    license: "MIT",
    dist: { integrity },
  };
}

function lakeInfo(value: unknown): {
  packageJson: string;
  extensions: Array<{ module: string; source: string; packageJson: string }>;
} {
  assertRecord(value, "lake info");
  const packageJson = value["packageJson"];
  const extensions = value["extensions"];
  assertNonEmptyString(packageJson, "lake packageJson");
  assert.ok(Array.isArray(extensions), "lake extensions must be an array");
  return {
    packageJson,
    extensions: extensions.map((extension) => {
      assertRecord(extension, "lake extension");
      const module = extension["module"];
      const source = extension["source"];
      const extensionPackageJson = extension["packageJson"];
      assertNonEmptyString(module, "extension module");
      assertNonEmptyString(source, "extension source");
      assertNonEmptyString(extensionPackageJson, "extension packageJson");
      return { module, source, packageJson: extensionPackageJson };
    }),
  };
}

function nodeResult(value: unknown): { id: string; title?: string } {
  assertRecord(value, "node result");
  const id = value["id"];
  const title = value["title"];
  assertNonEmptyString(id, "node id");
  if (title !== undefined) assertNonEmptyString(title, "node title");
  return { id, ...(title === undefined ? {} : { title }) };
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object`,
  );
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  assert.ok(typeof value === "string" && value.length > 0, `${label} must be a non-empty string`);
}

function archiveName(name: string, version: string): string {
  return `${name.replace(/^@/u, "").replaceAll("/", "-")}-${version}.tgz`;
}

function listArchive(archive: string): string[] {
  return run("tar", ["-tzf", archive], root).trim().split("\n");
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

async function waitForSupervisor(stdout: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let output = "";
  while (true) {
    const next = await reader.read();
    if (next.done) throw new Error(`Supervisor exited before readiness: ${output}`);
    output += decoder.decode(next.value, { stream: true });
    if (output.includes('"ready":true')) {
      reader.releaseLock();
      return;
    }
  }
}
