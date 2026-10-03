import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ApiSurface } from '../domain/surface.js';
import { createFsSurfaceCache, surfaceCachePath } from './fs-surface-cache.js';

const surface: ApiSurface = {
  package: '@acme/demo',
  version: '1.0.0',
  extractedAt: '2026-09-27T00:00:00.000Z',
  adapter: 'typescript',
  symbols: [{ path: 'a', kind: 'variable', signature: 'const a: 1', exportedFrom: ['.'] }],
};

describe('createFsSurfaceCache', () => {
  it('round-trips a surface and misses on a different schema', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'uptide-sc-'));
    const cache = createFsSurfaceCache({ dir });
    const key = { package: '@acme/demo', version: '1.0.0', adapter: 'typescript', schema: 1 };
    expect(await cache.get(key)).toBeUndefined();
    await cache.set(key, surface);
    expect(await cache.get(key)).toEqual(surface);
    expect(await cache.get({ ...key, schema: 2 })).toBeUndefined();
  });

  it('nests scoped packages as directories', () => {
    const key = { package: '@acme/demo', version: '1.0.0', adapter: 'typescript', schema: 3 };
    expect(surfaceCachePath('/c', key)).toBe('/c/surfaces/typescript/v3/@acme/demo/1.0.0.json');
  });
});
