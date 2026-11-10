import { workAutoBot } from "@botlake/extension-work-auto-bot";

import agents from "./agents.ts";
import work from "./work.ts";

export default workAutoBot({ agents, work });
