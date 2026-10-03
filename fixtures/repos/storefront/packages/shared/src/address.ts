import { z } from 'zod';

export const addressSchema = z.object({
  line1: z.string({ required_error: 'Address line is required' }).min(1),
  city: z.string({ required_error: 'City is required' }),
  postalCode: z.string({
    required_error: 'Postal code is required',
    invalid_type_error: 'Postal code must be a string',
  }),
  country: z.string({ required_error: 'Country is required' }).length(2),
});

export type Address = z.infer<typeof addressSchema>;
