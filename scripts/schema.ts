import { configJsonSchema } from "@millstrand/core";
import { jobJsonSchema } from "@millstrand/spool-cron";
import { flagsConfigJsonSchema } from "@millstrand/spool-flags";
import { harnessConfigJsonSchema } from "@millstrand/spool-harnesses";
import { z } from "zod";
const name = z.enum(["workspace", "job", "harnesses", "flags"]).parse(Bun.argv[2]);
const schemas = {
  workspace: configJsonSchema,
  job: jobJsonSchema,
  harnesses: harnessConfigJsonSchema,
  flags: flagsConfigJsonSchema,
};
process.stdout.write(`${JSON.stringify(schemas[name](), null, 2)}\n`);
