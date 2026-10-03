import { z } from 'zod';

export const user = z.object({
  name: z.string({
    required_error: 'Name is required',
    invalid_type_error: 'Name must be a string',
  }),
  age: z.number({ invalid_type_error: 'Age must be a number' }).int(),
});

export type User = z.infer<typeof user>;
