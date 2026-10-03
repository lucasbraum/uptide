import { UptideError } from '../../errors.js';
import type { LockGraph, LockRecord } from './lock-guard.js';

interface Block {
  key: string;
  lines: string[];
}
const unquote = (s: string) => s.trim().replace(/^['"]|['"]$/g, '');
const meaningful = (lines: string[]) =>
  lines.filter((l) => l.trim() && !l.trimStart().startsWith('#'));
function blocks(lines: string[], indent: number): Block[] {
  const out: Block[] = [];
  for (const line of meaningful(lines)) {
    const spaces = line.length - line.trimStart().length;
    if (spaces === indent) {
      const header = /^(.*):(?:\s*\{\})?\s*$/.exec(line.trim());
      if (!header)
        throw new UptideError('UNSUPPORTED_LOCKFILE', `Cannot safely parse lock entry: ${line}`);
      // The header as written: a Yarn block names several descriptors, some quoted.
      out.push({ key: (header[1] ?? '').trim(), lines: [] });
    } else {
      const block = out.at(-1);
      if (!block || spaces < indent)
        throw new UptideError('UNSUPPORTED_LOCKFILE', `Invalid lockfile indentation: ${line}`);
      block.lines.push(line);
    }
  }
  return out;
}
function dependencyPairs(lines: string[], indent: number): [string, string][] {
  const pairs: [string, string][] = [];
  let inDependencies = false;
  for (const line of lines) {
    const spaces = line.length - line.trimStart().length;
    if (spaces === indent)
      inDependencies = /^\s*(?:dependencies|optionalDependencies|peerDependencies):$/.test(line);
    if (!inDependencies || spaces !== indent + 2) continue;
    const match = /^\s*(?:"([^"]+)"|'([^']+)'|([^\s:]+))(?::\s+|\s+)(.+)$/.exec(line);
    if (!match) throw new UptideError('UNSUPPORTED_LOCKFILE', `Cannot resolve dependency: ${line}`);
    pairs.push([match[1] ?? match[2] ?? match[3] ?? '', unquote(match[4] ?? '')]);
  }
  return pairs;
}
/** Discard only the target dependency block, never text merely mentioning its name. */
function omitTarget(lines: string[], target: string): string[] {
  const out: string[] = [];
  let dependencyIndent = -1,
    skippedIndent = -1;
  for (const line of meaningful(lines)) {
    const indent = line.length - line.trimStart().length;
    if (skippedIndent >= 0 && indent > skippedIndent) continue;
    skippedIndent = -1;
    if (/^\s*(?:dependencies|devDependencies|optionalDependencies|peerDependencies):$/.test(line))
      dependencyIndent = indent;
    else if (indent <= dependencyIndent) dependencyIndent = -1;
    if (dependencyIndent >= 0 && indent === dependencyIndent + 2) {
      const key = /^(?:"([^"]+)"|'([^']+)'|([^\s:]+))(?::|\s)/.exec(line.trim());
      if ((key?.[1] ?? key?.[2] ?? key?.[3]) === target) {
        skippedIndent = indent;
        continue;
      }
    }
    out.push(line);
  }
  return out;
}
const packageName = (descriptor: string) =>
  descriptor.slice(0, descriptor.indexOf('@', descriptor.startsWith('@') ? 1 : 0));
/**
 * A Yarn block's descriptors, each unquoted, in a stable order: `"a@npm:b@^1", a@^1` and
 * `a@^1, "a@npm:b@^1"` are the same entry however yarn chose to quote and order them.
 */
export function yarnKey(header: string): string {
  return yarnDescriptors(header).sort().join(', ');
}
/** `"a@npm:b@^1", c@^1` → `['a@npm:b@^1', 'c@^1']`: split outside quotes, then unquoted. */
function yarnDescriptors(header: string): string[] {
  const out: string[] = [];
  let current = '';
  let quoted = false;
  for (const ch of header) {
    if (ch === '"') quoted = !quoted;
    else if (ch === ',' && !quoted) {
      out.push(current);
      current = '';
    } else current += ch;
  }
  out.push(current);
  // Berry quotes the whole list as one string: `"a@npm:^1, a@npm:^2":`. No descriptor
  // contains a comma, so what is left after unquoting splits on them.
  return out
    .flatMap((piece) => unquote(piece).split(/,\s*/))
    .map((d) => d.trim())
    .filter(Boolean);
}
/**
 * What a lock entry says, as values: version, resolution, integrity and dependencies by
 * name. Quoting and key order are the file's business; a change here is a real change.
 */
export function parsedEntry(lines: string[], indent: number): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  let section: string | undefined;
  for (const line of meaningful(lines)) {
    const spaces = line.length - line.trimStart().length;
    const body = line.trim();
    if (spaces === indent) {
      const nested = /^(?:"([^"]+)"|'([^']+)'|([^\s:]+)):$/.exec(body);
      if (nested) {
        section = nested[1] ?? nested[2] ?? nested[3];
        data[section as string] = {};
        continue;
      }
      section = undefined;
      const pair = /^(?:"([^"]+)"|'([^']+)'|([^\s:]+))(?::\s+|\s+)(.+)$/.exec(body);
      if (pair) data[pair[1] ?? pair[2] ?? pair[3] ?? ''] = unquote(pair[4] ?? '');
      else data[body] = true;
    } else if (section && spaces === indent + 2) {
      const pair = /^(?:"([^"]+)"|'([^']+)'|([^\s:]+))(?::\s+|\s+)(.+)$/.exec(body);
      if (pair)
        (data[section] as Record<string, string>)[pair[1] ?? pair[2] ?? pair[3] ?? ''] = unquote(
          pair[4] ?? '',
        );
      else (data[section] as Record<string, unknown>)[body] = true;
    } else {
      // Deeper nesting (Berry's `bin:`, `checksum`...) is kept as text under its section.
      const bucket = section ? (data[section] as Record<string, unknown>) : data;
      bucket[`#${body}`] = true;
    }
  }
  return data;
}

/**
 * Generated Yarn lockfiles use block mappings; a block is only a grouping of descriptors that
 * resolve the same way, and yarn regroups them freely (an alias `a-cjs@npm:a@^4` leaves or
 * joins `a@^4`'s block between installs). The graph is therefore keyed by descriptor, each
 * carrying its block's parsed values: the same resolution grouped differently is no change.
 * Unknown constructs fail closed.
 */
export function yarnGraph(text: string, target: string): LockGraph {
  const records = new Map<string, LockRecord>();
  const metadata: Record<string, unknown> = {};
  const entries = blocks(text.split('\n'), 0);
  for (const b of entries) {
    if (unquote(b.key) === '__metadata' || b.key.includes('@workspace:')) {
      metadata[unquote(b.key)] = omitTarget(b.lines, target);
      continue;
    }
    const descriptors = yarnDescriptors(b.key);
    const name = packageName(descriptors[0] ?? '');
    if (!name || !b.lines.some((l) => /^ {2}version[: ]/.test(l)))
      throw new UptideError('UNSUPPORTED_LOCKFILE', `Unknown Yarn entry ${b.key}`);
    const data = parsedEntry(b.lines, 2);
    const dependencies = dependencyPairs(b.lines, 2).map(([n, r]) => `${n}@${r}`);
    for (const d of descriptors) records.set(d, { name, dependencies, data });
  }
  // A dependency names a descriptor; `a@npm:b@^1` is how an alias is written on both sides.
  for (const record of records.values())
    record.dependencies = record.dependencies.filter((d) => records.has(d));
  return { records, metadata };
}

export function pnpmGraph(text: string, target: string): LockGraph {
  const records = new Map<string, LockRecord>();
  const metadata: string[] = [];
  let section = '',
    lines: string[] = [];
  function flush() {
    if (section !== 'packages' && section !== 'snapshots') {
      if (section === 'catalogs') {
        let skip = false;
        metadata.push(
          ...meaningful(lines).filter((line) => {
            const indent = line.length - line.trimStart().length;
            if (indent <= 4)
              skip = indent === 4 && unquote(line.trim().replace(/:$/, '')) === target;
            return !skip;
          }),
        );
      } else metadata.push(...omitTarget(lines, target));
      return;
    }
    for (const b of blocks(lines.slice(1), 2)) {
      const key = unquote(b.key).replace(/^\//, '');
      records.set(`${section}:${key}`, {
        name: packageName(key),
        dependencies: [],
        data: parsedEntry(b.lines, 4),
      });
      if (section === 'snapshots') {
        const r = records.get(`${section}:${key}`) as LockRecord;
        r.dependencies = dependencyPairs(b.lines, 4).flatMap(([n, v]) => [
          `snapshots:${n}@${v}`,
          `packages:${n}@${v.replace(/\(.*$/, '')}`,
        ]);
      }
    }
  }
  for (const line of meaningful(text.split('\n'))) {
    if (!line.startsWith(' ')) {
      flush();
      section = line.split(':')[0] ?? '';
      lines = [line];
    } else lines.push(line);
  }
  flush();
  for (const record of records.values())
    record.dependencies = record.dependencies.filter((k) => records.has(k));
  return { records, metadata };
}
