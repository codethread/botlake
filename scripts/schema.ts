import { configJsonSchema } from "@botlake/core";
import { agentConfigJsonSchema } from "@botlake/extension-agents";
import { jobJsonSchema } from "@botlake/extension-cron";
import { flagsConfigJsonSchema } from "@botlake/extension-flags";
import { z } from "zod";
const name = z.compile(z.enum(["workspace", "job", "agents", "flags"])).parse(Bun.argv[2]);
const schemas = {
  workspace: configJsonSchema,
  job: jobJsonSchema,
  agents: agentConfigJsonSchema,
  flags: flagsConfigJsonSchema,
};
process.stdout.write(`${JSON.stringify(schemas[name](), null, 2)}\n`);
