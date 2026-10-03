import { z } from 'zod';

/** One line of the access log the edge proxy ships to the API. */
export const accessLogSchema = z.object({
  requestId: z.string().uuid(),
  clientIp: z.string().ip(),
  path: z.string(),
  status: z.number().int(),
  at: z.string().datetime(),
});

export type AccessLog = z.infer<typeof accessLogSchema>;
