import { agentReferenceProjections } from "@botlake/extension-agents";
import { references } from "@botlake/extension-references";
import { workReferenceProjections } from "@botlake/extension-work";

export default references({
  projections: [...workReferenceProjections, ...agentReferenceProjections],
});
