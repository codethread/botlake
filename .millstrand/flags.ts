import { flags } from "@millstrand/spool-flags";

export default flags({
  "harness/claude": false,
  "harness/cursor": false,
  "seat/allow-china": true,
  "model/openai": true,
  "model/anthropic": true,
  "model/xai": true,
});
