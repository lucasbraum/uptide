import { z } from 'zod';

export const productSchema = z.object({
  id: z.string().uuid(),
  sku: z.string({ required_error: 'SKU is required' }).min(3),
  name: z.string({ required_error: 'Name is required' }),
  priceCents: z.number({
    required_error: 'Price is required',
    invalid_type_error: 'Price must be a number',
  }),
  imageUrl: z.string().url().optional(),
  createdAt: z.string().datetime(),
});

export const stockUpdateSchema = z.object({
  productId: z.string().uuid(),
  quantity: z.number({ required_error: 'Quantity is required' }).int().nonnegative(),
});

export type Product = z.infer<typeof productSchema>;
