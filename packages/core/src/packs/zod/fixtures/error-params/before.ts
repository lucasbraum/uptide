import { z } from 'zod';

// Literal messages: one callback that tells missing input from invalid input.
export const name = z.string({ required_error: 'Name is required' }); // @uptide error-params at:z.string
export const age = z.number({ invalid_type_error: 'Age must be a number' }); // @uptide error-params at:z.number
export const code = z.string({ /* both */ required_error: 'A', invalid_type_error: 'B', description: 'd' }); // @uptide error-params at:z.string
export const role = z.enum(['admin', 'user'], { required_error: 'Pick a role' }); // @uptide error-params at:z.enum

// Not literals: captured once, in their original order.
const label = (field: string) => `${field} is required`;
export const city = z.string({ required_error: label('City') }); // @uptide error-params at:z.string

// Left for a person: an existing errorMap must be merged by hand, a spread may hide the keys.
export const merged = z.string({ required_error: 'x', errorMap: () => ({ message: 'y' }) }); // @uptide error-params keep at:z.string
const base = { description: 'shared' };
export const spread = z.string({ ...base, required_error: 'x' }); // @uptide error-params keep at:z.string
