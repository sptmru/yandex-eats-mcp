import { z } from "zod";

export const orderPhaseSchema = z.enum([
  "unknown",
  "accepted",
  "preparing",
  "courier_assigned",
  "picked_up",
  "arriving",
  "delivered",
  "cancelled",
]);

export const normalizedOrderStatusSchema = z.object({
  orderNr: z.string(),
  phase: orderPhaseSchema,
  terminal: z.boolean(),
  title: z.string().optional(),
  subtitle: z.string().optional(),
  etaText: z.string().optional(),
  progressKey: z.string().optional(),
  courierAssigned: z.boolean().optional(),
  updatedAt: z.string(),
  fingerprint: z.string(),
});

export const orderEventTypeSchema = z.enum([
  "order.discovered",
  "order.status_changed",
  "order.eta_changed",
  "order.courier_assigned",
  "order.terminal",
  "monitor.auth_expired",
  "monitor.recovered",
  "monitor.diagnostic",
]);

export const orderEventSchema = z.object({
  id: z.string().uuid(),
  sequence: z.number().int().positive(),
  occurredAt: z.string(),
  type: orderEventTypeSchema,
  orderNr: z.string().optional(),
  previous: normalizedOrderStatusSchema.optional(),
  current: normalizedOrderStatusSchema.optional(),
  summary: z.string(),
});

export type OrderPhase = z.infer<typeof orderPhaseSchema>;
export type NormalizedOrderStatus = z.infer<typeof normalizedOrderStatusSchema>;
export type OrderEventType = z.infer<typeof orderEventTypeSchema>;
export type OrderEvent = z.infer<typeof orderEventSchema>;

export type OrderMonitorHealth = {
  monitorEnabled: boolean;
  monitorHealthy: boolean;
  authExpired: boolean;
  lastSuccessfulPollAt?: string;
  orders: NormalizedOrderStatus[];
};

export type OrderEventPage = {
  events: OrderEvent[];
  nextSequence: number;
  hasMore: boolean;
};
