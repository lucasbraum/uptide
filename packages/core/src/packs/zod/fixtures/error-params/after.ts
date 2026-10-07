import { z } from 'zod';

// Literal messages: one callback that tells missing input from invalid input.
export const name = z.string({ error: (iss) => iss.input === undefined ? 'Name is required' : undefined }); // @uptide error-params at:z.string
export const age = z.number({ error: (iss) => iss.input === undefined ? undefined : 'Age must be a number' }); // @uptide error-params at:z.number
export const code = z.string({ /* both */ error: (iss) => iss.input === undefined ? 'A' : 'B',  description: 'd' }); // @uptide error-params at:z.string
export const role = z.enum(['admin', 'user'], { error: (iss) => iss.input === undefined ? 'Pick a role' : undefined }); // @uptide error-params at:z.enum

// Not literals: captured once, in their original order.
const label = (field: string) => `${field} is required`;
export const city = z.string((<T extends { required_error?: string; invalid_type_error?: string }>(options: T) => { const { required_error, invalid_type_error, ...rest } = options; return { ...rest, error: (iss: { input: unknown }) => iss.input === undefined ? required_error : invalid_type_error }; })({ required_error: label('City') })); // @uptide error-params at:z.string

// Left for a person: an existing errorMap must be merged by hand, a spread may hide the keys.
export const merged = z.string({ required_error: 'x', errorMap: () => ({ message: 'y' }) }); // @uptide error-params keep at:z.string
const base = { description: 'shared' };
export const spread = z.string({ ...base, required_error: 'x' }); // @uptide error-params keep at:z.string
