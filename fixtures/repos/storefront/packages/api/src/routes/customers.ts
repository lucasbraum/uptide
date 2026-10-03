import { addressSchema, fieldErrors } from '@storefront/shared';
import { z } from 'zod';

export const signUpSchema = z.object({
  email: z.string({ required_error: 'Email is required' }).email('Email is not valid'),
  name: z.string({ required_error: 'Name is required' }).min(2, 'Name is too short'),
  password: z.string({ required_error: 'Password is required' }).min(12),
  address: addressSchema.optional(),
});

export const updateCustomerSchema = z.object({
  name: z.string({ invalid_type_error: 'Name must be a string' }).optional(),
  marketingOptIn: z.boolean({ invalid_type_error: 'Opt-in must be true or false' }).optional(),
});

export function signUp(body: unknown) {
  const parsed = signUpSchema.safeParse(body);
  if (!parsed.success) return { status: 400, errors: fieldErrors(parsed.error) };
  return { status: 201, customer: parsed.data };
}
