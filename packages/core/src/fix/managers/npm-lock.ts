import { dirname } from 'node:path';
import { UptideError } from '../../errors.js';
import { type LockGraph, type LockRecord, withoutTarget } from './lock-guard.js';

type Entry = Record<string, unknown> & {
  dependencies?: Record<string, Entry | string>;
  requires?: Record<string, string>;
};
export function npmGraph(text: string, target: string): LockGraph {
  const lock = JSON.parse(text);
  if (![2, 3].includes(lock.lockfileVersion) || !lock.packages)
    throw new UptideError(
      'UNSUPPORTED_LOCKFILE',
      'npm fix requires package-lock lockfileVersion 2 or 3',
    );
  const records = new Map<string, LockRecord>();
  const nodes = new Map<string, Entry>();
  const importers: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(lock.packages) as [string, Entry][]) {
    if (!key.includes('node_modules/')) importers[key] = withoutTarget(entry, target);
    else nodes.set(key, entry);
  }
  function legacy(deps: Record<string, Entry | string>, parent = 'legacy') {
    for (const [name, entry] of Object.entries(deps)) {
      if (typeof entry === 'string') continue;
      const key = `${parent}/node_modules/${name}`;
      const { dependencies, ...own } = entry;
      // npm v2 repeats workspace declarations in the compatibility tree.
      const workspace =
        typeof own.version === 'string' && own.version.startsWith('file:')
          ? own.version.slice(5)
          : undefined;
      if (workspace && Object.hasOwn(importers, workspace) && own.requires) {
        own.requires = { ...own.requires };
        delete own.requires[target];
      }
      nodes.set(key, own);
      if (dependencies) legacy(dependencies, key);
    }
  }
  if (lock.dependencies) legacy(lock.dependencies);
  function resolve(from: string, name: string): string | undefined {
    let dir = from;
    for (;;) {
      const key = `${dir ? `${dir}/` : ''}node_modules/${name}`;
      if (nodes.has(key)) return key;
      if (!dir || dir === '.') return undefined;
      dir = dirname(dir);
      if (dir === '.') dir = '';
    }
  }
  for (const [key, entry] of nodes) {
    const names = new Set(
      ['dependencies', 'optionalDependencies', 'peerDependencies', 'requires'].flatMap((s) =>
        Object.keys((entry[s] ?? {}) as object),
      ),
    );
    // v2's compatibility tree may include bundled children without a requires field.
    for (const child of nodes.keys())
      if (
        child.startsWith(`${key}/node_modules/`) &&
        !child.slice(key.length + 14).includes('/node_modules/')
      )
        names.add(child.slice(key.length + 14));
    records.set(key, {
      name: key.slice(key.lastIndexOf('node_modules/') + 13),
      data: entry,
      dependencies: [...names].flatMap((n) => {
        const r = resolve(key, n);
        return r ? [r] : [];
      }),
    });
  }
  const { packages: _p, dependencies: _d, ...meta } = lock;
  return { records, metadata: { ...meta, importers } };
}
