import batteriesExtension from "@botlake/extension-batteries";
import cronExtension from "@botlake/extension-cron";
import { mailIdentity, ui } from "@botlake/extension-ct-config";
import diaryExtension from "@botlake/extension-diary";
import identityExtension from "@botlake/extension-identity";
import { mail as createMail } from "@botlake/extension-mail";
import { mailAgents as createMailAgents } from "@botlake/extension-mail-agents";

import agents from "./agents.ts";

const mail = createMail({ idleWake: { byProvider: { codex: 12 * 60 * 60, claude: 60 * 60 } } });

export const packageExtensions = {
  batteries: batteriesExtension,
  cron: cronExtension,
  diary: diaryExtension,
  identity: identityExtension,
  mail,
  mailAgents: createMailAgents({ agents, mail }),
  mailIdentity,
  ui,
};
