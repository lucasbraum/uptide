import { dirname } from 'node:path';
import { UptideError } from '../../errors.js';
import {
  type LockGraph,
  type LockRecord,
  lockedIdentity,
  type Targets,
  targetNames,
  withoutTarget,
} from './lock-guard.js';

type Entry = Record<string, unknown> & {
  dependencies?: Record<string, Entry | string>;
  requires?: Record<string, string>;
};
export function npmGraph(text: string, target: Targets): LockGraph {
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
        for (const name of targetNames(target)) delete own.requires[name];
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
      if (!dir.endsWith('node_modules') && nodes.has(key)) return key;
      if (!dir || dir === '.' || dir === 'legacy') return undefined;
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
    // Only bundled children imply an edge without a declaration; placement alone does not.
    for (const [child, data] of nodes)
      if (
        (data.bundled === true || data.inBundle === true) &&
        child.startsWith(`${key}/node_modules/`) &&
        !child.slice(key.length + 14).includes('/node_modules/')
      )
        names.add(child.slice(key.length + 14));
    const edges = Object.fromEntries([...names].map((n) => [n, resolve(key, n)]));
    const name = key.slice(key.lastIndexOf('node_modules/') + 13);
    records.set(key, {
      name,
      identity: lockedIdentity(String(entry.name ?? name), entry.version, entry.integrity, entry),
      edges,
      data: entry,
      dependencies: Object.values(edges).filter((r): r is string => r !== undefined),
    });
  }
  const { packages: _p, dependencies: _d, ...meta } = lock;
  const roots = Object.fromEntries(
    Object.entries(lock.packages as Record<string, Entry>)
      .filter(([key]) => !key.includes('node_modules/'))
      .map(([key, entry]) => [
        key,
        Object.fromEntries(
          ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']
            .flatMap((s) => Object.keys((entry[s] ?? {}) as object))
            .map((name) => [name, resolve(key, name)]),
        ),
      ]),
  );
  function relocate(key: string, previous: LockGraph): string | undefined {
    if (records.has(key)) return key;
    const name = previous.records.get(key)?.name;
    if (!name) return undefined;
    const parent = key.slice(0, key.lastIndexOf('node_modules/')).replace(/\/$/, '');
    const placed = previous.records.has(parent) ? relocate(parent, previous) : parent;
    return placed === undefined ? undefined : resolve(placed, name);
  }
  return { records, metadata: { ...meta, importers }, roots, relocate };
}
