import { q, type Node } from "@botlake/core";
import { z } from "zod";

export const mailAttributes = {
  /** Marks a message node. */
  message: "mail/message",
  /** Core identity credited as sender. */
  from: "mail/from",
  /** Core identity addressed by this direct message. */
  to: "mail/to",
  /** Immutable message contents. */
  body: "mail/body",
  /** Attention request, independent of task authority. */
  urgent: "mail/urgent",
  /** Continuation already admitted for this message; prevents repeated wakes. */
  wakeRun: "mail/wake-run",
  /** Observed delivery and acknowledgement lifecycle. */
  delivery: "mail/delivery",
} as const;
export const mailRelations = {
  /** Reply message to its single parent message. */
  repliesTo: "mail/replies-to",
  /** Message to a contextual node, such as a task or run; not proof of participation. */
  about: "mail/about",
  /** Message to its registered sender identity; owned by the optional integration. */
  sentBy: "mail/sent-by",
  /** Message to its registered recipient identity; owned by the optional integration. */
  sentTo: "mail/sent-to",
} as const;
export const deliverySchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("undeliverable"),
    reason: z.string().min(1),
    detail: z.string().nullable(),
    deliveredAt: z.null(),
    acknowledgedAt: z.null(),
  }),
  z.object({ status: z.literal("sent"), deliveredAt: z.null(), acknowledgedAt: z.null() }),
  z.object({ status: z.literal("delivered"), deliveredAt: z.number(), acknowledgedAt: z.null() }),
  z.object({
    status: z.literal("acknowledged"),
    deliveredAt: z.number().nullable(),
    acknowledgedAt: z.number(),
  }),
]);
export const mailDataSchema = z.object({
  [mailAttributes.message]: z.literal(true),
  [mailAttributes.from]: z.string().min(1),
  [mailAttributes.to]: z.string().min(1),
  [mailAttributes.body]: z.string().min(1).max(16000),
  [mailAttributes.urgent]: z.boolean(),
  [mailAttributes.delivery]: deliverySchema,
});
export const mailPredicate = q.eq(q.attr(mailAttributes.message), true);
export const pendingPredicate = q.and(
  mailPredicate,
  q.inArray(q.attr(mailAttributes.delivery, "status"), ["sent", "delivered"]),
);

export function mailData(node: Node) {
  return mailDataSchema.parse(node.attributes);
}
