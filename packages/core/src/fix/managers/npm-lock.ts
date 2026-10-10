import { dirname } from 'node:path';
import { compareVersions, parseVersion } from '../../check/version.js';
import { UptideError } from '../../errors.js';
import { satisfies } from '../../fetch/range.js';
import {
  type LockGraph,
  type LockRecord,
  lockedIdentity,
  lockScope,
  type PeerReresolution,
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

/** npm may re-resolve reverse peers; only existing, in-range, same-major upgrades qualify. */
export function npmPeerReresolutions(
  before: LockGraph,
  after: LockGraph,
  planned: Targets,
  scope: Targets = planned,
): PeerReresolution[] {
  const allowed = lockScope(before, after, scope);
  const names = targetNames(planned);
  const results: PeerReresolution[] = [];
  for (const [key, old] of before.records) {
    if (allowed.has(key)) continue;
    const next = after.records.get(key);
    const from = String(old.identity.version ?? ''),
      to = String(next?.identity.version ?? '');
    const parsed = parseVersion(from),
      target = parseVersion(to);
    if (
      !next ||
      old.name !== next.name ||
      !parsed ||
      !target ||
      parsed.major !== target.major ||
      compareVersions(to, from) <= 0
    )
      continue;
    const peers = Object.keys(old.data.peerDependencies ?? {}).filter((name) =>
      names.includes(name),
    );
    if (!peers.length) continue;
    const ranges: Record<string, string> = {};
    const collect = (
      dependent: string,
      data: Record<string, unknown>,
      edges: Record<string, string | undefined>,
    ) => {
      if (edges[old.name] !== key) return;
      for (const field of [
        'dependencies',
        'devDependencies',
        'optionalDependencies',
        'peerDependencies',
        'requires',
      ]) {
        const range = (data[field] as Record<string, unknown> | undefined)?.[old.name];
        if (typeof range === 'string') ranges[`${dependent || '.'} (${field})`] = range;
      }
    };
    for (const [dependent, record] of before.records) collect(dependent, record.data, record.edges);
    const importers = (before.metadata as { importers: Record<string, Record<string, unknown>> })
      .importers;
    for (const [dependent, edges] of Object.entries(before.roots ?? {}))
      collect(dependent, importers[dependent] ?? {}, edges);
    if (
      !Object.keys(ranges).length ||
      !Object.values(ranges).every((range) => satisfies(from, range) && satisfies(to, range))
    )
      continue;
    const legacy = `legacy/${key}`;
    const records = [key];
    if (
      before.records.get(legacy)?.identity.version === from &&
      after.records.get(legacy)?.identity.version === to
    )
      records.push(legacy);
    results.push({ name: old.name, from, to, peers, ranges, records });
  }
  return results;
}
