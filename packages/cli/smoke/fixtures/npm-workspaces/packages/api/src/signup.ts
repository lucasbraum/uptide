import { z } from 'zod';

export const signup = z.object({
  email: z.string({ required_error: 'Email is required' }),
  plan: z.enum(['free', 'pro'], { invalid_type_error: 'Unknown plan' }),
});

export type Signup = z.infer<typeof signup>;
