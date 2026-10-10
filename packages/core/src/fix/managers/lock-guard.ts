import { UptideError } from '../../errors.js';

export interface LockRecord {
  name: string;
  dependencies: string[];
  data: Record<string, unknown>;
  identity: Record<string, unknown>;
  edges: Record<string, string | undefined>;
}
export interface LockGraph {
  records: Map<string, LockRecord>;
  metadata: unknown;
  roots?: Record<string, Record<string, string | undefined>>;
  /** npm placements can disappear when a copy is hoisted to an ancestor. */
  relocate?(key: string, previous: LockGraph): string | undefined;
}
const sections = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
/** What an upgrade moves: one package, or a package and the companions that move with it. */
export type Targets = string | readonly string[];
export const targetNames = (targets: Targets): readonly string[] =>
  typeof targets === 'string' ? [targets] : targets;
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export function withoutTarget(
  value: Record<string, unknown>,
  target: Targets,
): Record<string, unknown> {
  const result = structuredClone(value);
  for (const section of sections) {
    if (result[section] && typeof result[section] === 'object')
      for (const name of targetNames(target))
        delete (result[section] as Record<string, unknown>)[name];
  }
  return result;
}
/** Content identity plus fields which affect execution or platform selection. */
export function lockedIdentity(
  name: string,
  version: unknown,
  integrity: unknown,
  data: Record<string, unknown>,
): Record<string, unknown> {
  return {
    name,
    version,
    integrity,
    // Without a content hash, a changed locator is not evidence of identical contents.
    source: integrity == null ? (data.resolved ?? data.resolution) : undefined,
    ...Object.fromEntries(
      [
        'scripts',
        'bin',
        'os',
        'cpu',
        'libc',
        'engines',
        'hasInstallScript',
        'requiresBuild',
        'hasBin',
        'hasShrinkwrap',
        'link',
        'inBundle',
      ].map((k) => [k, data[k]]),
    ),
  };
}
export interface LockHousekeeping {
  deduped: { from: string; to: string; name: string; version: string }[];
  metadata: string[];
}
export interface PeerReresolution {
  name: string;
  from: string;
  to: string;
  peers: string[];
  ranges: Record<string, string>;
  records: string[];
}
export interface LockDiff {
  added: string[];
  removed: string[];
  changed: string[];
  allowed: string[];
  housekeeping?: LockHousekeeping;
  peerReresolved?: PeerReresolution[];
}
/** Placements reachable from the authorized roots in either lockfile. */
export function lockScope(
  before: LockGraph,
  after: LockGraph,
  target: Targets,
  extraRoots: readonly string[] = [],
): Set<string> {
  const names = targetNames(target);
  const allowed = new Set<string>();
  for (const graph of [before, after]) {
    const queue = [...graph.records]
      .filter(([key, r]) => names.includes(r.name) || extraRoots.includes(key))
      .map(([k]) => k);
    const visited = new Set<string>();
    for (const key of queue) {
      if (visited.has(key)) continue;
      visited.add(key);
      allowed.add(key);
      queue.push(...(graph.records.get(key)?.dependencies ?? []));
    }
  }
  return allowed;
}
/** Union authorized subtrees, then protect every outside dependent's actual resolution. */
export function assertLockScope(
  before: LockGraph,
  after: LockGraph,
  target: Targets,
  extraRoots: readonly string[] = [],
): LockDiff {
  const names = targetNames(target);
  const originalScope = lockScope(before, after, target);
  const allowed = lockScope(before, after, target, extraRoots);
  const diff: LockDiff = { added: [], removed: [], changed: [], allowed: [...allowed].sort() };
  const housekeeping: LockHousekeeping = { deduped: [], metadata: [] };
  const unexpected = new Set<string>();
  if (stable(before.metadata) !== stable(after.metadata))
    unexpected.add('lockfile metadata/importers');

  const equivalent = (a: string, b: string, seen = new Set<string>()): boolean => {
    const left = before.records.get(a),
      right = after.records.get(b);
    if (!left || !right || stable(left.identity) !== stable(right.identity)) return false;
    const pair = JSON.stringify([a, b]);
    if (seen.has(pair)) return true;
    seen.add(pair);
    return sameEdges(left.edges, right.edges, seen);
  };
  const sameEdges = (
    left: Record<string, string | undefined>,
    right: Record<string, string | undefined>,
    seen = new Set<string>(),
  ): boolean =>
    [...new Set([...Object.keys(left), ...Object.keys(right)])].every((name) => {
      if (!Object.hasOwn(left, name) || !Object.hasOwn(right, name)) return false;
      const a = left[name],
        b = right[name];
      if (a === undefined || b === undefined) return a === b;
      // Intended upgrades stay authorized; dedupe from an outside copy must still compare.
      if (originalScope.has(a) && originalScope.has(b)) return true;
      // Admitted peers may move; their transitive upgrades cannot change an outside consumer.
      if (extraRoots.includes(a) && extraRoots.includes(b)) return true;
      return equivalent(a, b, seen);
    });
  for (const key of new Set([
    ...Object.keys(before.roots ?? {}),
    ...Object.keys(after.roots ?? {}),
  ]))
    if (!sameEdges(before.roots?.[key] ?? {}, after.roots?.[key] ?? {}))
      unexpected.add(`importer ${key || '.'} resolutions`);

  const counterpart = (
    key: string,
    from: LockGraph,
    to: LockGraph,
    reverse = false,
  ): string | undefined => {
    if (to.records.has(key)) return key;
    if (to.relocate) {
      const placed = to.relocate(key, from);
      if (placed !== undefined && (reverse ? equivalent(placed, key) : equivalent(key, placed)))
        return placed;
      // npm can move an identical copy down into several dependents as well as hoist it.
      // Root/edge checks above still require every outside dependent to resolve identically.
    }
    // Logical lockfiles address descriptors/snapshots rather than physical placements.
    return [...to.records.keys()].find((other) =>
      reverse ? equivalent(other, key) : equivalent(key, other),
    );
  };
  const keys = new Set([...before.records.keys(), ...after.records.keys()]);
  const relocated = new Map<string, string>();
  for (const key of keys) {
    const a = before.records.get(key),
      b = after.records.get(key);
    const changed = stable(a?.data) !== stable(b?.data);
    if (changed)
      diff[a === undefined ? 'added' : b === undefined ? 'removed' : 'changed'].push(key);
    if (allowed.has(key)) continue;
    const other = a
      ? counterpart(key, before, after)
      : (counterpart(key, after, before, true) ?? relocated.get(key));
    if (other === undefined || !(a ? equivalent(key, other) : equivalent(other, key))) {
      unexpected.add(key);
      continue;
    }
    if (!a || !b) {
      // Old records are visited first; a newly hoisted copy can replace a removed one.
      if (a) relocated.set(other, key);
      const record = a ?? b;
      if (!record) continue;
      const from = a ? key : other,
        to = a ? other : key;
      if (!housekeeping.deduped.some((d) => d.from === from && d.to === to))
        housekeeping.deduped.push({
          from,
          to,
          name: record.name,
          version: String(record.identity.version ?? ''),
        });
    } else if (changed) housekeeping.metadata.push(key);
  }
  if (unexpected.size) {
    const versionOf = (graph: LockGraph, key: string): string | undefined => {
      const version = graph.records.get(key)?.identity.version;
      return version === undefined ? undefined : String(version);
    };
    const described = [...unexpected].map((key) => {
      if (!keys.has(key)) return key;
      const [a, b] = [versionOf(before, key), versionOf(after, key)];
      return a === undefined
        ? `${key} (added${b ? ` at ${b}` : ''})`
        : b === undefined
          ? `${key} (removed, was ${a})`
          : a !== b
            ? `${key} (${a} → ${b})`
            : `${key} (same version, different resolution, dependencies or execution fields)`;
    });
    throw new UptideError(
      'LOCKFILE_OUT_OF_SCOPE',
      `Install changed resolutions outside ${names.join(', ')}'s dependency subtree: ${described.join('; ')}. No upgrade will be committed.`,
    );
  }
  if (housekeeping.deduped.length || housekeeping.metadata.length) diff.housekeeping = housekeeping;
  return diff;
}
