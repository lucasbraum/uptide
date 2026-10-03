import { UptideError } from '../../errors.js';

export interface LockRecord {
  name: string;
  dependencies: string[];
  data: unknown;
}
export interface LockGraph {
  records: Map<string, LockRecord>;
  metadata: unknown;
}
const sections = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
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
  target: string,
): Record<string, unknown> {
  const result = structuredClone(value);
  for (const section of sections) {
    if (result[section] && typeof result[section] === 'object')
      delete (result[section] as Record<string, unknown>)[target];
  }
  return result;
}
export interface LockDiff {
  added: string[];
  removed: string[];
  changed: string[];
  allowed: string[];
}
/** Compare entries, not lines: formatting changes cannot disguise an unrelated resolution. */
export function assertLockScope(before: LockGraph, after: LockGraph, target: string): LockDiff {
  const allowed = new Set<string>();
  for (const graph of [before, after]) {
    const queue = [...graph.records].filter(([, r]) => r.name === target).map(([k]) => k);
    const visited = new Set<string>();
    for (const key of queue) {
      if (visited.has(key)) continue;
      visited.add(key);
      allowed.add(key);
      queue.push(...(graph.records.get(key)?.dependencies ?? []));
    }
  }
  const diff: LockDiff = { added: [], removed: [], changed: [], allowed: [...allowed].sort() };
  const unexpected: string[] = [];
  if (stable(before.metadata) !== stable(after.metadata))
    unexpected.push('lockfile metadata/importers');
  for (const key of new Set([...before.records.keys(), ...after.records.keys()])) {
    const a = before.records.get(key),
      b = after.records.get(key);
    if (stable(a?.data) === stable(b?.data)) continue;
    diff[a === undefined ? 'added' : b === undefined ? 'removed' : 'changed'].push(key);
    if (!allowed.has(key)) unexpected.push(key);
  }
  if (unexpected.length) {
    const versionOf = (graph: LockGraph, key: string): string | undefined => {
      const data = graph.records.get(key)?.data;
      return data && typeof data === 'object' && 'version' in data
        ? String((data as { version: unknown }).version)
        : undefined;
    };
    const described = unexpected.map((key) => {
      if (key === 'lockfile metadata/importers') return key;
      const [a, b] = [versionOf(before, key), versionOf(after, key)];
      return a === undefined
        ? `${key} (added${b ? ` at ${b}` : ''})`
        : b === undefined
          ? `${key} (removed, was ${a})`
          : a !== b
            ? `${key} (${a} → ${b})`
            : `${key} (same version, different resolution or dependencies)`;
    });
    throw new UptideError(
      'LOCKFILE_OUT_OF_SCOPE',
      `Install changed entries outside ${target}'s dependency subtree: ${described.join('; ')}. No upgrade will be committed.`,
    );
  }
  return diff;
}
