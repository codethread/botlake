// Build self-contained native plugins into a marketplace directory (default out/plugins).
// Plugin managers copy plugin directories without Bun workspace links, so each entry point is
// bundled. Versions carry a content digest: Claude caches per version and Codex re-requests hook
// trust when plugin scripts change.
// Usage: bun scripts/plugins.ts [OUTPUT]
import { createHash } from "node:crypto";
import { cp, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { z } from "zod";

const root = resolve(import.meta.dir, "..");
const output = resolve(Bun.argv[2] ?? join(root, "out/plugins"));
const marketplace = "botlake";
const manifest = z
  .object({ name: z.string(), version: z.string(), description: z.string().optional() })
  .loose();
const sourceMarket = z.object({
  plugins: z.array(z.object({ name: z.string(), source: z.object({ path: z.string() }) }).loose()),
});

await rm(output, { recursive: true, force: true });
const { plugins } = sourceMarket.parse(
  await Bun.file(join(root, ".agents/plugins/marketplace.json")).json(),
);
const claude: { name: string; source: string; description: string }[] = [];
for (const plugin of plugins) {
  const source = join(root, plugin.source.path);
  const target = join(output, plugin.name);
  const built = await Bun.build({
    entrypoints: ["hook.ts", "pi.ts"].map((entry) => join(source, entry)),
    outdir: target,
    // Manifests invoke hook.ts; Bun and Pi both run bundled JavaScript under a .ts name.
    naming: "[name].ts",
    target: "bun",
  });
  if (!built.success) throw new AggregateError(built.logs, `Failed to bundle ${plugin.name}`);
  const digest = createHash("sha256");
  for (const artifact of built.outputs) digest.update(await artifact.text());
  // Claude loads hooks modules from source: the engine statically checks how `register` and `$`
  // are spelled, which bundling would rewrite. They must import nothing at run time.
  const module = Bun.file(join(source, "claude.ts"));
  if (await module.exists()) {
    await cp(join(source, "claude.ts"), join(target, "claude.ts"));
    digest.update(await module.text());
  }
  for (const host of [".claude-plugin", ".codex-plugin"]) {
    await cp(join(source, host), join(target, host), { recursive: true });
    digest.update(await Bun.file(join(source, host, "hooks.json")).text());
  }
  const version = digest.digest("hex").slice(0, 12);
  let description = "";
  for (const host of [".claude-plugin", ".codex-plugin"]) {
    const file = join(target, host, "plugin.json");
    const parsed = manifest.parse(await Bun.file(file).json());
    description = parsed.description ?? "";
    await Bun.write(
      file,
      `${JSON.stringify({ ...parsed, version: `${parsed.version}+${version}` }, null, 2)}\n`,
    );
  }
  // Pi loads the bundled extension from this package; no dependencies remain to install.
  await Bun.write(
    join(target, "package.json"),
    `${JSON.stringify({ name: plugin.name, private: true, type: "module", pi: { extensions: ["./pi.ts"] } }, null, 2)}\n`,
  );
  await cp(join(source, "README.md"), join(target, "README.md"));
  claude.push({ name: plugin.name, source: `./${plugin.name}`, description });
}
await mkdir(join(output, ".claude-plugin"), { recursive: true });
await Bun.write(
  join(output, ".claude-plugin/marketplace.json"),
  `${JSON.stringify({ name: marketplace, owner: { name: "Botlake" }, plugins: claude }, null, 2)}\n`,
);
await mkdir(join(output, ".agents/plugins"), { recursive: true });
await Bun.write(
  join(output, ".agents/plugins/marketplace.json"),
  `${JSON.stringify(
    {
      name: marketplace,
      plugins: plugins.map((plugin) => ({
        ...plugin,
        source: { source: "local", path: `./${plugin.name}` },
      })),
    },
    null,
    2,
  )}\n`,
);
console.log(JSON.stringify({ marketplace, output, plugins: claude.map((plugin) => plugin.name) }));
