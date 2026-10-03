import { z } from 'zod';

export const paymentWebhookSchema = z.object({
  id: z.string({ required_error: 'Event id is required' }),
  type: z.enum(['payment.succeeded', 'payment.failed']),
  createdAt: z.string().datetime(),
  payload: z.object({
    orderId: z.string({ required_error: 'Order id is required' }).uuid(),
    amountCents: z.number({ required_error: 'Amount is required' }).int(),
  }),
});

export const shipmentWebhookSchema = z.object({
  id: z.string({ required_error: 'Event id is required' }),
  trackingCode: z.string({ required_error: 'Tracking code is required' }).min(6),
  deliveredAt: z.string().datetime().optional(),
});
