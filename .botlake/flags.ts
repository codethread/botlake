import { flags } from "@botlake/extension-flags";

export default flags({
  "harness/claude": false,
  "harness/cursor": false,
  "seat/allow-china": true,
  "model/openai": true,
  "model/anthropic": true,
  "model/xai": true,
});
