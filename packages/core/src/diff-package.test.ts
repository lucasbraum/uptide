import { describe, expect, it, vi } from 'vitest';
import { diffPackage, surfaceOf } from './diff-package.js';
import type { LanguageAdapter, PackageDir } from './domain/adapter.js';
import type { PackageFetcher, SurfaceCache } from './domain/io.js';
import { type ApiSurface, SURFACE_SCHEMA_VERSION } from './domain/surface.js';

const adapter: LanguageAdapter = {
  id: 'fake',
  async extractSurface(pkg: PackageDir): Promise<ApiSurface> {
    return {
      package: pkg.name,
      version: pkg.version,
      extractedAt: '2026-09-27T00:00:00.000Z',
      adapter: 'fake',
      symbols:
        pkg.version === '1.0.0'
          ? [{ path: 'a', kind: 'variable', signature: 'const string', exportedFrom: ['.'] }]
          : [{ path: 'b', kind: 'variable', signature: 'const string', exportedFrom: ['.'] }],
    };
  },
};

function memoryCache(): SurfaceCache & { store: Map<string, ApiSurface> } {
  const store = new Map<string, ApiSurface>();
  const k = (key: { package: string; version: string; adapter: string; schema: number }) =>
    `${key.package}@${key.version}/${key.adapter}/${key.schema}`;
  return {
    store,
    async get(key) {
      return store.get(k(key));
    },
    async set(key, surface) {
      store.set(k(key), surface);
    },
  };
}

const fetcher: PackageFetcher = {
  resolve: async (_name, requested) => requested,
  fetch: vi.fn(async (name: string, version: string) => ({
    name,
    version,
    dir: `/definitely/not/under/tmp/${name}/${version}`,
  })),
};

describe('diffPackage', () => {
  it('fetches, extracts, caches and diffs both versions', async () => {
    const cache = memoryCache();
    const changes = await diffPackage({
      name: 'demo',
      from: '1.0.0',
      to: '2.0.0',
      adapter,
      fetcher,
      cache,
    });
    expect(changes.map((c) => `${c.kind}:${c.path}`)).toEqual(['removed:a', 'added:b']);
    expect(changes[0]).toMatchObject({
      package: 'demo',
      from: '1.0.0',
      to: '2.0.0',
      replacement: 'b',
    });
    expect([...cache.store.keys()]).toEqual([
      `demo@1.0.0/fake/${SURFACE_SCHEMA_VERSION}`,
      `demo@2.0.0/fake/${SURFACE_SCHEMA_VERSION}`,
    ]);
  });

  it('serves a cached surface without fetching', async () => {
    const cache = memoryCache();
    const fetchSpy = vi.fn(fetcher.fetch);
    const stubbed: PackageFetcher = { fetch: fetchSpy, resolve: async (_n, r) => r };
    await surfaceOf('demo', '1.0.0', { adapter, fetcher: stubbed, cache });
    await surfaceOf('demo', '1.0.0', { adapter, fetcher: stubbed, cache });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
