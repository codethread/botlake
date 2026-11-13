import { createLake } from "@botlake/core";

import agents from "./src/agents.ts";
import flags from "./src/flags.ts";
import { packageExtensions } from "./src/package-extensions.ts";
import priming from "./src/priming.ts";
import references from "./src/references.ts";
import workAgents from "./src/work-agents.ts";
import workAutoBot from "./src/work-auto-bot.ts";
import work from "./src/work.ts";
import workflow from "./src/workflow.ts";

export const lake = createLake({
  name: "botlake",
  minimumCore: "0.3.1",
  extensions: [
    packageExtensions.batteries,
    packageExtensions.identity,
    packageExtensions.diary,
    flags,
    references,
    agents,
    packageExtensions.mail,
    packageExtensions.mailIdentity,
    packageExtensions.mailAgents,
    priming,
    work,
    workAgents,
    workAutoBot,
    workflow,
    packageExtensions.cron,
    packageExtensions.ui,
  ],
});
