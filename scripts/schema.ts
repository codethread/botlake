import { configJsonSchema } from "@millstrand/core";
import { jobJsonSchema } from "@millstrand/spool-cron";
import { harnessConfigJsonSchema } from "@millstrand/spool-harnesses";
import { z } from "zod";
const name = z.enum(["workspace", "job", "harnesses"]).parse(Bun.argv[2]);
const schemas = {
  workspace: configJsonSchema,
  job: jobJsonSchema,
  harnesses: harnessConfigJsonSchema,
};
process.stdout.write(`${JSON.stringify(schemas[name](), null, 2)}\n`);
