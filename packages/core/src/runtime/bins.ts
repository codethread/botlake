import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { z } from "zod";

import { Fault } from "../core/json.ts";
import type { Op } from "./context.ts";
import { defineOp } from "./ops.ts";

const absolutePath = z.string().min(1).refine(isAbsolute, "Expected an absolute path");
const environment = z.record(z.string().regex(/^[^=\0]+$/u), z.string());
const binSchema = z.strictObject({
  description: z.string().min(1),
  exec: z.union([
    z.strictObject({ path: absolutePath, env: environment.default({}) }),
    z.strictObject({ command: z.string().regex(/^[^/\\\s]+$/u), env: environment.default({}) }),
  ]),
  build: z
    .strictObject({ argv: z.array(z.string().min(1)).min(1), cwd: absolutePath })
    .exactOptional(),
});
export type Bin = z.input<typeof binSchema>;

async function runnable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return (await stat(path)).isFile();
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      ["ENOENT", "EACCES", "ENOTDIR"].includes(String(error.code))
    )
      return false;
    throw error;
  }
}

export class Bins {
  private readonly entries = new Map<string, z.output<typeof binSchema>>();
  register(name: string, bin: Bin): void {
    z.string().regex(/^\S+$/u).parse(name);
    if (this.entries.has(name)) throw new Fault("collision", `Duplicate bin: ${name}`);
    this.entries.set(name, binSchema.parse(bin));
  }
  operation(): Op {
    return defineOp({
      name: "bins",
      input: z.discriminatedUnion("command", [
        z.strictObject({ command: z.literal("list") }),
        z.strictObject({ command: z.literal("plan"), name: z.string().min(1) }),
      ]),
      output: z.json(),
      cli: {
        description: "Inspect spool-declared executables and build recipes",
        commands: {
          list: { description: "List declared bins" },
          plan: {
            description: "Inspect an executable and its build recipe",
            positionals: [{ name: "name", type: "string", required: true }],
          },
        },
        examples: ["mill bin list", "mill bin build NAME", "mill bin run NAME [ARGS...]"],
      },
      handler: async (input) => {
        if (input.command === "list")
          return {
            operation: "bins list",
            bins: [...this.entries].map(([name, bin]) => ({ name, description: bin.description })),
          };
        const bin = this.entries.get(input.name);
        if (bin === undefined) throw new Fault("bin/unknown", `Unknown bin: ${input.name}`);
        return {
          operation: "bins plan",
          bin: input.name,
          ...bin,
          runnable: "path" in bin.exec ? await runnable(bin.exec.path) : null,
        };
      },
    });
  }
}
