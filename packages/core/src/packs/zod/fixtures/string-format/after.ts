import { z } from 'zod';

// Formats move to top-level factories; options and the rest of the chain stay.
export const contact = z.email({ error: 'Invalid address' }).optional(); // @uptide string-format at:.email( path:ZodString#email
export const id = z.uuid(); // @uptide string-format at:.uuid( path:ZodString#uuid
export const createdAt = z.iso.datetime({ offset: true }); // @uptide string-format at:.datetime( path:ZodString#datetime

// Left for a person: a refinement before the format, and options on z.string() itself.
export const trimmed = z.string().trim().email(); // @uptide string-format keep at:.email( path:ZodString#email
export const described = z.string({ description: 'link' }).url(); // @uptide string-format keep at:.url( path:ZodString#url
