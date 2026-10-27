import { configJsonSchema } from "@botlake/core";
import { jobJsonSchema } from "@botlake/extension-cron";
import { flagsConfigJsonSchema } from "@botlake/extension-flags";
import { harnessConfigJsonSchema } from "@botlake/extension-harnesses";
import { z } from "zod";
const name = z.enum(["workspace", "job", "harnesses", "flags"]).parse(Bun.argv[2]);
const schemas = {
  workspace: configJsonSchema,
  job: jobJsonSchema,
  harnesses: harnessConfigJsonSchema,
  flags: flagsConfigJsonSchema,
};
process.stdout.write(`${JSON.stringify(schemas[name](), null, 2)}\n`);
