import { workflows } from "@botlake/extension-workflow";

import { cutoverSmoke } from "./workflows/cutover-smoke.ts";

export default workflows({ definitions: [cutoverSmoke] });
