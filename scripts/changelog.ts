import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

import {
  changelogHistorySchema,
  changelogQuerySchema,
  changelogVersionSchema,
  queryChangelog,
  renderChangelog,
  renderChangelogMarkdown,
} from "@codethread/cli-changelog";
import { z } from "zod";

const root = join(import.meta.dirname, "..");
const historyPath = join(root, "cli", "changelog.json");
const markdownPath = join(root, "cli", "CHANGELOG.md");
const versionOutputSchema = z.object({ cli_version: changelogVersionSchema });
const usage =
  "Usage: bun scripts/changelog.ts {query [--version VERSION] [--since VERSION | --release VERSION] [--limit N] [--offset N] [--json] | generate | check}";

const [command, ...commandArgs] = Bun.argv.slice(2);

if (command === "generate") {
  requireNoArguments(commandArgs);
  await generate();
} else if (command === "check") {
  requireNoArguments(commandArgs);
  await check();
} else if (command === "query") {
  await query(commandArgs);
} else {
  throw new Error(usage);
}

async function generate(): Promise<void> {
  const history = await readHistory();
  const markdown = renderChangelogMarkdown({ title: "Botlake CLI", history });
  await writeFile(markdownPath, markdown);
  console.log("Generated cli/CHANGELOG.md from cli/changelog.json.");
}

async function check(): Promise<void> {
  const history = await readHistory();
  const expected = renderChangelogMarkdown({ title: "Botlake CLI", history });
  const actual = await readFile(markdownPath, "utf8");
  if (actual !== expected) {
    console.error("cli/CHANGELOG.md is out of sync; run `bun run changelog:generate`.");
    process.exitCode = 1;
    return;
  }
  console.log("cli/CHANGELOG.md matches cli/changelog.json.");
}

async function query(queryArgs: string[]): Promise<void> {
  const { values } = parseArgs({
    args: queryArgs,
    strict: true,
    allowPositionals: false,
    options: {
      version: { type: "string" },
      since: { type: "string" },
      release: { type: "string" },
      limit: { type: "string" },
      offset: { type: "string" },
      json: { type: "boolean", default: false },
    },
  });
  const version = changelogVersionSchema.parse(values.version ?? (await currentVersion()));
  const input = changelogQuerySchema.parse({
    since: values.since,
    release: values.release,
    limit: values.limit,
    offset: values.offset,
  });
  const page = queryChangelog({ tool: "Botlake CLI", version }, await readHistory(), input);
  if (values.json) {
    console.log(JSON.stringify(page, null, 2));
    return;
  }
  process.stdout.write(renderChangelog(page));
}

async function readHistory() {
  const source: unknown = JSON.parse(await readFile(historyPath, "utf8"));
  return changelogHistorySchema.parse(source);
}

async function currentVersion(): Promise<string> {
  const executable = join(root, "out", "botlake");
  if (!(await Bun.file(executable).exists())) {
    throw new Error(`Missing ${executable}; run \`mise run bootstrap\` first.`);
  }
  const child = Bun.spawn([executable, "--version"], {
    cwd: root,
    stdout: "pipe",
    stderr: "inherit",
  });
  const output = await new Response(child.stdout).text();
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`Could not read the CLI release version (exit ${exitCode}).`);
  }
  const source: unknown = JSON.parse(output);
  return versionOutputSchema.parse(source).cli_version;
}

function requireNoArguments(remainingArguments: string[]): void {
  if (remainingArguments.length > 0) {
    throw new Error(usage);
  }
}
