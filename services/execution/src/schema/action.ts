import { z } from "zod";

export const ActionEnum = z.enum([
  "RETRY_PAYMENT",
  "SEND_PAYMENT_LINK",
  "SEND_REMINDER",
  "ESCALATE_TO_HUMAN",
  "LOG_PROMISE_TO_PAY",
  "STOP_SEQUENCE",
]);

export const ChannelEnum = z.enum([
  "in_app",
  "sms",
  "email",
  "whatsapp",
  "voice",
  "none",
]);

export const RecoveryActionSchema = z.object({
  action: ActionEnum,
  target: z.object({
    order_id: z.string(),
    customer_id: z.string().optional(),
  }),
  channel: ChannelEnum.default("none"),
  reasoning: z.string(),
  authorized_by_rule: z.string().nullable(),
  attempt_number: z.number().int().min(1),
  cooldown_until: z.string().datetime().nullable().optional(),
});

export type RecoveryAction = z.infer<typeof RecoveryActionSchema>;
