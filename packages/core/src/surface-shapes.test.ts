import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTypescriptAdapter } from './adapters/typescript/index.js';
import { diffDirs } from './diff-package.js';
import type { SurfaceCache } from './domain/io.js';
import type { ApiSurface } from './domain/surface.js';

const ROOT = resolve(import.meta.dirname, '../../../fixtures');
const adapter = createTypescriptAdapter({ now: () => new Date('2026-09-28T00:00:00.000Z') });

function memoryCache(): SurfaceCache {
  const store = new Map<string, ApiSurface>();
  return {
    async get(k) {
      return store.get(`${k.package}@${k.version}`);
    },
    async set(k, s) {
      store.set(`${k.package}@${k.version}`, s);
    },
  };
}

const dir = (name: string, version: string) => ({
  name,
  version,
  dir: join(ROOT, name === 'shape' ? 'export-shape' : name, version === '1.0.0' ? 'v1' : 'v2'),
});

describe('inherited members are part of the apparent member set', () => {
  it('members moved onto bases and mixins are not removed (the zod 4 shape)', async () => {
    const { changes, surfaceB } = await diffDirs(
      dir('inherited', '1.0.0'),
      dir('inherited', '2.0.0'),
      {
        adapter,
        cache: memoryCache(),
      },
    );
    const removed = changes.filter((c) => c.kind === 'removed').map((c) => c.path);
    expect(removed).toEqual([]);
    const paths = surfaceB.symbols.map((s) => s.path);
    expect(paths).toEqual(
      expect.arrayContaining(['Str#min', 'Str#max', 'Str.create', 'Failure#issues']),
    );
    // The inherited copy keeps the base's file and is emitted under the derived path only.
    expect(surfaceB.symbols.find((s) => s.path === 'Str#min')?.file).toBe('index.d.ts');
  });
});

describe('export = and export default are the same shape to a consumer', () => {
  it('sharp 0.34 -> 0.35: the root and its namespace members are not removed', async () => {
    const { changes, surfaceA } = await diffDirs(dir('shape', '1.0.0'), dir('shape', '2.0.0'), {
      adapter,
      cache: memoryCache(),
    });
    expect(surfaceA.symbols.find((s) => s.path === 'shape')?.exportEquals).toBe(true);
    expect(changes.filter((c) => c.severity === 'breaking')).toEqual([]);
    expect(changes.filter((c) => c.kind === 'added').map((c) => c.path)).toEqual([]);
  });
});

describe('type alias value changes', () => {
  it('a literal alias that changes value is a type change; a union that loses a member is narrowed', async () => {
    const at = (v: string) => ({
      name: 'alias-value',
      version: v,
      dir: join(ROOT, 'alias-value', v === '1.0.0' ? 'v1' : 'v2'),
    });
    const { changes } = await diffDirs(at('1.0.0'), at('2.0.0'), { adapter, cache: memoryCache() });
    const by = Object.fromEntries(changes.map((c) => [c.path, c]));
    expect(by.Version).toMatchObject({ kind: 'type', severity: 'breaking' });
    expect(by.Mode).toMatchObject({ kind: 'narrowed' });
    expect(by['Config#apiVersion']).toBeUndefined();
    // Re-declared through `import('./lib.js').X = typeof ApiVersion`: the literal is what changed.
    expect(by.LatestApiVersion).toMatchObject({ kind: 'type', severity: 'breaking' });
  });
});
