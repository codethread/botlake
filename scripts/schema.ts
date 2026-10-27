import { configJsonSchema } from "@botlake/core";
import { jobJsonSchema } from "@botlake/spool-cron";
import { flagsConfigJsonSchema } from "@botlake/spool-flags";
import { harnessConfigJsonSchema } from "@botlake/spool-harnesses";
import { z } from "zod";
const name = z.enum(["workspace", "job", "harnesses", "flags"]).parse(Bun.argv[2]);
const schemas = {
  workspace: configJsonSchema,
  job: jobJsonSchema,
  harnesses: harnessConfigJsonSchema,
  flags: flagsConfigJsonSchema,
};
process.stdout.write(`${JSON.stringify(schemas[name](), null, 2)}\n`);
