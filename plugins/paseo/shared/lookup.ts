import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const lookup = defineRpc({
  name: "identity.lookup",
  input: z.object({ agentId: z.string().min(1) }),
  output: z.discriminatedUnion("status", [
    z.object({ status: z.literal("registered"), identity: z.string().min(1) }),
    z.object({ status: z.literal("no-session") }),
    z.object({ status: z.literal("not-registered") }),
  ]),
});
