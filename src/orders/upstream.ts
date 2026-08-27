import { z } from "zod";

const updateSettingsSchema = z.object({
  update_period: z.number().finite().positive().optional(),
  order_nrs_to_update: z.array(z.union([z.string(), z.number()]).transform(String)).optional(),
}).passthrough();

export const rawOrdersEnvelopeSchema = z.object({
  orders: z.array(z.unknown()).optional(),
  update_settings: updateSettingsSchema.optional(),
}).passthrough();

export const rawOrderDetailsEnvelopeSchema = z.object({
  order: z.unknown().optional(),
  update_settings: z.object({
    update_payload: z.unknown().optional(),
    period_s: z.number().finite().positive().optional(),
  }).passthrough().optional(),
  pre_open: z.unknown().optional(),
}).passthrough();

export const rawTrackingEnvelopeSchema = z.object({
  tracked_order: z.unknown().optional(),
  polling_policy: z.object({
    full_update_after: z.number().finite().positive().optional(),
  }).passthrough().optional(),
}).passthrough();

export type RawOrdersEnvelope = z.infer<typeof rawOrdersEnvelopeSchema>;
export type RawOrderDetailsEnvelope = z.infer<typeof rawOrderDetailsEnvelopeSchema>;
export type RawTrackingEnvelope = z.infer<typeof rawTrackingEnvelopeSchema>;
