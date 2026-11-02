import { priming } from "@botlake/core";

import { agentPrimer } from "./agents.ts";

export default priming({
  work: "Record a concise outcome before closing a task.",
  agent: agentPrimer,
});
