import { setErrorMap, type ZodEffects, ZodError, z } from 'zod';

enum Color {
  Red = 'red',
  Green = 'green',
}

// z.record with one argument (4.x requires the key schema), .email() and nativeEnum (deprecated in 4.x).
export const user = z.object({
  email: z.string().email(),
  color: z.nativeEnum(Color),
  tags: z.record(z.string()),
});

// .merge is deprecated in 4.x.
export const extended = user.merge(z.object({ extra: z.number() }));
export type Extended = z.infer<typeof extended>;

// ZodEffects moves to zod/v3 in 4.x.
export const length: ZodEffects<z.ZodString, number> = z.string().transform((s) => s.length);

setErrorMap(() => ({ message: 'nope' }));

export function parse(input: unknown): Extended | { formErrors: string[] } {
  try {
    return extended.parse(input);
  } catch (err) {
    if (err instanceof ZodError) return { formErrors: err.flatten().formErrors };
    throw err;
  }
}
