// Maintained excerpts/paraphrases of https://zod.dev/v4/changelog, checked 2026-10-01.
// Runtime never downloads migration instructions.
export const zodGuide = {
  errors:
    'Zod 4 uses error for customization. required_error and invalid_type_error were removed. Distinguish missing input using issue.input === undefined; returning undefined delegates to the default error map. Do not combine the old keys with errorMap.',
  formats:
    'String formats moved to top-level factories. email, uuid, url and base64 are on z; datetime is on z.iso. Keep validation options and subsequent chain operations. message is deprecated in favor of error.',
  ip: 'The combined string.ip validator was removed. Use z.ipv4() or z.ipv6() when the intended family is known; use z.union([z.ipv4(), z.ipv6()]) when the previous validator accepted both families. These are top-level factories, not z.string() methods. Preserve options and error text.',
  generics:
    'ZodType now takes Output and Input, defaulting to unknown. The definition type parameter is gone. Remove reliance on ZodTypeDef without weakening the input/output contract. SafeParse success contains data; failure contains error. Narrow on success before accessing either. Preserve validation and type safety; do not cast to any to hide diagnostics.',
};
