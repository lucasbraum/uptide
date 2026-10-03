import { expect, it } from 'vitest';
import { assertLockScope } from './lock-guard.js';
import { npmGraph } from './npm-lock.js';

const lock = (v: number, target: string, child: string, unrelated = '1.0.0') =>
  JSON.stringify({
    lockfileVersion: v,
    name: 'app',
    version: '1.0.0',
    packages: {
      '': { dependencies: { target: `^${target}`, stable: '^1.0.0' } },
      'packages/api': { dependencies: { target: `~${target}` } },
      'node_modules/target': { version: target, dependencies: { child: `^${child}` } },
      'node_modules/child': { version: child },
      'node_modules/stable': { version: unrelated },
    },
    ...(v === 2
      ? {
          dependencies: {
            target: { version: target, requires: { child: `^${child}` } },
            child: { version: child },
            stable: { version: unrelated },
          },
        }
      : {}),
  });
it.each([2, 3])('permits only the target and its resolved subtree in npm lockfile v%s', (v) => {
  const before = npmGraph(lock(v, '1.0.0', '1.0.0'), 'target');
  const after = npmGraph(lock(v, '2.0.0', '2.0.0'), 'target');
  expect(assertLockScope(before, after, 'target').changed).toContain('node_modules/child');
  expect(() =>
    assertLockScope(before, npmGraph(lock(v, '2.0.0', '2.0.0', '1.1.0'), 'target'), 'target'),
  ).toThrow('outside target');
});
it('rejects unrelated importer changes, removals and integrity changes, not only version bumps', () => {
  const original = lock(3, '1.0.0', '1.0.0');
  const before = npmGraph(original, 'target');
  for (const mutate of [
    (x: {
      packages: Record<string, { dependencies: Record<string, string>; integrity?: string }>;
    }) => {
      const entry = x.packages[''];
      if (entry) entry.dependencies.stable = '^2.0.0';
    },
    (x: {
      packages: Record<string, { dependencies: Record<string, string>; integrity?: string }>;
    }) => {
      delete x.packages['node_modules/stable'];
    },
    (x: {
      packages: Record<string, { dependencies: Record<string, string>; integrity?: string }>;
    }) => {
      const entry = x.packages['node_modules/stable'];
      if (entry) entry.integrity = 'tampered';
    },
  ]) {
    const next = JSON.parse(original);
    mutate(next);
    expect(() =>
      assertLockScope(before, npmGraph(JSON.stringify(next), 'target'), 'target'),
    ).toThrow('outside target');
  }
});
it('rejects unsupported npm v1 instead of accepting an incomplete comparison', () => {
  expect(() => npmGraph('{"lockfileVersion":1}', 'target')).toThrow('lockfileVersion 2 or 3');
});
it('allows only target ranges in npm v2 workspace compatibility records', () => {
  const make = (target: string, stable = '^1') =>
    JSON.stringify({
      lockfileVersion: 2,
      packages: { 'packages/api': { dependencies: { target, stable } } },
      dependencies: { api: { version: 'file:packages/api', requires: { target, stable } } },
    });
  const before = npmGraph(make('^1'), 'target');
  expect(() => assertLockScope(before, npmGraph(make('^2'), 'target'), 'target')).not.toThrow();
  expect(() => assertLockScope(before, npmGraph(make('^2', '^2'), 'target'), 'target')).toThrow(
    'outside target',
  );
});
