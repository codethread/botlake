import { priming } from "@botlake/core";

import { agentPrimer } from "./agents.ts";

export default priming({
  work: [
    "The Notes field is for recording a concise outcome before closing a task.",
    "Assigning to the user must only be done as a last resort when oracle can't unblock you or if given prior consent to do so",
  ].join("\n"),
  agent: agentPrimer,
});
