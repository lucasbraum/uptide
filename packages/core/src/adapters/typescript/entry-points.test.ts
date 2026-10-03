import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NoTypesError } from '../../errors.js';
import { resolveEntryPoints } from './entry-points.js';

const ROOT = resolve(import.meta.dirname, '../../../../../fixtures/typed-layouts');

describe('resolveEntryPoints', () => {
  it('finds an index.d.ts in the directory of main', () => {
    expect(resolveEntryPoints(join(ROOT, 'main-dir'), 'main-dir', '1.0.0')).toEqual([
      { entry: '.', file: join(ROOT, 'main-dir/lib/index.d.ts') },
    ]);
  });
  it('says so when there really are no declarations', () => {
    expect(() => resolveEntryPoints(join(ROOT, 'none'), 'none', '1.0.0')).toThrow(NoTypesError);
  });
});
