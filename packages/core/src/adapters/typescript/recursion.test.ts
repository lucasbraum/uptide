import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { diffDirs } from '../../diff-package.js';
import type { SurfaceCache } from '../../domain/io.js';
import type { ApiSurface } from '../../domain/surface.js';
import { createTypescriptAdapter } from './index.js';
import { MAX_NESTING } from './walk.js';

const DEPS = resolve(import.meta.dirname, '../../../../../fixtures/deps');
const adapter = createTypescriptAdapter({ now: () => new Date('2026-10-05T00:00:00.000Z') });
const logkit = (major: 1 | 2) => ({
  name: 'logkit',
  version: `${major}.0.0`,
  dir: join(DEPS, `recursive-v${major}`),
});
const memoryCache = (): SurfaceCache => {
  const store = new Map<string, ApiSurface>();
  return {
    get: async (k) => store.get(`${k.package}@${k.version}`),
    set: async (k, s) => {
      store.set(`${k.package}@${k.version}`, s);
    },
  };
};
const cuts = (surface: ApiSurface) =>
  surface.symbols
    .filter((s) => s.signature.endsWith('(compared by name)'))
    .map((s) => `${s.path} → ${s.signature}`);

// Both used to overflow the call stack: `logkit.ping.other.other.other...` and, in v2,
// `logkit.default.default...` (uptide-dev/uptide#4, pino 10's `export { pino as default, pino }`).
it('extracts self-referencing and mutually recursive declarations, cutting each cycle once', async () => {
  const v1 = await adapter.extractSurface(logkit(1));
  expect(cuts(v1)).toEqual([
    'logkit.ping.other.other → recursive type logkit.ping (compared by name)',
    'logkit.pong.other.other → recursive type logkit.pong (compared by name)',
  ]);
  const v2 = await adapter.extractSurface(logkit(2));
  expect(cuts(v2)).toEqual([
    'logkit.default → recursive type logkit (compared by name)',
    'logkit.logkit → recursive type logkit (compared by name)',
    'logkit.ping.other.other → recursive type logkit.ping (compared by name)',
    'logkit.pong.other.other → recursive type logkit.pong (compared by name)',
  ]);
  // Recursive types within one declaration were never walked by structure: they stay whole.
  expect(v2.symbols.find((s) => s.path === 'logkit.Tree#children')?.signature).toBe('Tree[]');
});

it('diffs through a cut by what it stands for: name qualification hidden, type changes kept', async () => {
  for (const assignability of [false, true]) {
    const { changes } = await diffDirs(logkit(1), logkit(2), {
      adapter,
      cache: memoryCache(),
      assignability,
    });
    // v1's nested `logkit.logkit` (with its own `levels`) is v2's `logkit` itself: unchanged
    // members do not diff, though v2 never walks into `logkit.logkit`.
    expect(changes.map((c) => `${c.kind} ${c.path}`)).toEqual([
      'signature logkit',
      'removed logkit.Logger#parent',
      'added logkit.Options#timestamp',
      'added logkit.Settings',
      'added logkit.Settings#level',
      'added logkit.default',
      'signature logkit.logkit',
      'signature logkit.logkit.stdTimeFunctions#epochTime',
      'signature logkit.stdTimeFunctions#epochTime',
    ]);
    // A real change reachable only through the cut is reported with both real types: the cut
    // drops `logkit.` qualification, never a type.
    const through = (path: string) => {
      const c = changes.find((x) => x.path === path);
      return [c?.before, c?.after].map((t) => t?.replace(/<[^>]*>/g, ''));
    };
    expect(through('logkit.logkit')).toEqual([
      '(options?: Options): Logger',
      '(options?: Settings): Logger',
    ]);
    expect(through('logkit.logkit.stdTimeFunctions#epochTime')).toEqual([
      '() => string',
      '() => number',
    ]);
  }
});

it('cuts a walk nested deeper than the limit, without a cycle', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'uptide-deep-'));
  const depth = MAX_NESTING + 8;
  const open = Array.from({ length: depth }, (_, i) => `export namespace n${i} {`).join('\n');
  writeFileSync(
    join(dir, 'index.d.ts'),
    `${open}\nexport const leaf: number;\n${'}\n'.repeat(depth)}`,
  );
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'deep', types: 'index.d.ts' }));
  mkdirSync(join(dir, 'node_modules'));
  const surface = await adapter.extractSurface({ name: 'deep', version: '1.0.0', dir });
  const deepest = surface.symbols.at(-1);
  expect(deepest?.signature).toBe(`nested deeper than ${MAX_NESTING} levels (compared by name)`);
  expect(deepest?.path.split('.')).toHaveLength(MAX_NESTING + 1);
  expect(surface.symbols.some((s) => s.path.endsWith('.leaf'))).toBe(false);
});
