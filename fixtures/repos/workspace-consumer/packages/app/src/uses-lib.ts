import { fresh } from 'lib';

// Compiles only when `lib` resolves to its source: the stale dist does not declare `fresh`.
export const f: number = fresh;
