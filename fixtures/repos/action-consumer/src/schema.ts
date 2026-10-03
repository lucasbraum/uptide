import { z } from 'zod';
export const signup = z.object({
  email: z
    .string({ required_error: 'Email is required', invalid_type_error: 'Email must be text' })
    .email(),
});
