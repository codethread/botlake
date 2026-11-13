import batteriesExtension from "@botlake/extension-batteries";
import cronExtension from "@botlake/extension-cron";
import { mail, mailAgents, mailIdentity, ui } from "@botlake/extension-ct-config";
import diaryExtension from "@botlake/extension-diary";
import identityExtension from "@botlake/extension-identity";

export const packageExtensions = {
  batteries: batteriesExtension,
  cron: cronExtension,
  diary: diaryExtension,
  identity: identityExtension,
  mail,
  mailAgents,
  mailIdentity,
  ui,
};
