import { z } from "zod";

import { configJsonSchema, jobJsonSchema, harnessConfigJsonSchema } from "../src/index.ts";
const name = z.enum(["workspace", "job", "harnesses"]).parse(Bun.argv[2]);
const schemas = {
  workspace: configJsonSchema,
  job: jobJsonSchema,
  harnesses: harnessConfigJsonSchema,
};
process.stdout.write(`${JSON.stringify(schemas[name](), null, 2)}\n`);
