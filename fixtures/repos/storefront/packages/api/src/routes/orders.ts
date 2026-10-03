import { addressSchema } from '@storefront/shared';
import { z } from 'zod';

const lineItemSchema = z.object({
  productId: z.string({ required_error: 'Product is required' }).uuid(),
  quantity: z.number({ required_error: 'Quantity is required' }).int().positive(),
});

export const createOrderSchema = z.object({
  customerId: z.string({ required_error: 'Customer is required' }).uuid(),
  items: z.array(lineItemSchema).min(1, 'An order needs at least one item'),
  shipTo: addressSchema,
  note: z.string({ invalid_type_error: 'Note must be a string' }).max(500).optional(),
});

export const cancelOrderSchema = z.object({
  orderId: z.string({ required_error: 'Order is required' }).uuid(),
  reason: z.string({ required_error: 'Reason is required' }).min(5, 'Say why in a few words'),
});

export type CreateOrder = z.infer<typeof createOrderSchema>;
