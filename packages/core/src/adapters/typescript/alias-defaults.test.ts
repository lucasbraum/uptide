import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { diffDirs } from '../../diff-package.js';
import type { SurfaceCache } from '../../domain/io.js';
import type { ApiSurface } from '../../domain/surface.js';
import { createTypescriptAdapter } from './index.js';

const DEPS = resolve(import.meta.dirname, '../../../../../fixtures/deps');
const adapter = createTypescriptAdapter({ now: () => new Date('2026-10-07T00:00:00.000Z') });
const memoryCache = (): SurfaceCache => {
  const store = new Map<string, ApiSurface>();
  return {
    get: async (k) => store.get(`${k.package}@${k.version}`),
    set: async (k, s) => {
      store.set(`${k.package}@${k.version}`, s);
    },
  };
};
const diff = async (fixture: string, name: string) => {
  const pkg = (major: 1 | 2) => ({
    name,
    version: `${major}.0.0`,
    dir: join(DEPS, `${fixture}-v${major}`),
  });
  const { changes } = await diffDirs(pkg(1), pkg(2), { adapter, cache: memoryCache() });
  return changes.map((c) => `${c.kind} ${c.severity} ${c.path}`);
};

// The compat program declares each changed alias's old and new body as `type __a_N<params> =
// body`. Both used to take the body from the first ` = `, which sits inside a type parameter
// default, so the alias repeated the rest of its parameter list; over a template literal type
// ts-morph threw "Manipulation error: A syntax error was inserted".

it('compares type aliases whose type parameters have defaults (type-fest 4 -> 5)', async () => {
  expect(await diff('slice', 'slicekit')).toEqual([
    'type breaking CamelCase',
    // Judged by the checker: only a well-formed alias relates as widened.
    'widened additive Slice',
  ]);
});

it('compares type aliases whose defaults are generic instantiations (i18next 23 -> 26)', async () => {
  // `BackendModule<TOptions = object>` -> `BackendModule<Options = object>` only renames its
  // parameter: the checker finds the two equivalent.
  expect(await diff('backend', 'backendkit')).toEqual(['type breaking Lookup']);
});
