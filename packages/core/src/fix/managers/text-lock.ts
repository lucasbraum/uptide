import { parse as parseYaml } from 'yaml';
import { UptideError } from '../../errors.js';
import {
  type LockGraph,
  type LockRecord,
  lockedIdentity,
  type Targets,
  targetNames,
  withoutTarget,
} from './lock-guard.js';

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
      inDependencies =
        /^\s*(?:dependencies|devDependencies|optionalDependencies|peerDependencies):$/.test(line);
    if (!inDependencies || spaces !== indent + 2) continue;
    const match = /^\s*(?:"([^"]+)"|'([^']+)'|([^\s:]+))(?::\s+|\s+)(.+)$/.exec(line);
    if (!match) throw new UptideError('UNSUPPORTED_LOCKFILE', `Cannot resolve dependency: ${line}`);
    pairs.push([match[1] ?? match[2] ?? match[3] ?? '', unquote(match[4] ?? '')]);
  }
  return pairs;
}
/** Discard only the target dependency block, never text merely mentioning its name. */
function omitTarget(lines: string[], target: Targets): string[] {
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
      if (targetNames(target).includes(key?.[1] ?? key?.[2] ?? key?.[3] ?? '')) {
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
export function yarnGraph(text: string, target: Targets): LockGraph {
  const records = new Map<string, LockRecord>();
  const metadata: Record<string, unknown> = {};
  const roots: NonNullable<LockGraph['roots']> = {};
  const entries = blocks(text.split('\n'), 0);
  for (const b of entries) {
    if (unquote(b.key) === '__metadata' || b.key.includes('@workspace:')) {
      metadata[unquote(b.key)] = omitTarget(b.lines, target);
      if (b.key.includes('@workspace:'))
        roots[unquote(b.key)] = Object.fromEntries(
          dependencyPairs(b.lines, 2).map(([n, r]) => [n, `${n}@${r}`]),
        );
      continue;
    }
    const descriptors = yarnDescriptors(b.key);
    const name = packageName(descriptors[0] ?? '');
    if (!name || !b.lines.some((l) => /^ {2}version[: ]/.test(l)))
      throw new UptideError('UNSUPPORTED_LOCKFILE', `Unknown Yarn entry ${b.key}`);
    const data = parsedEntry(b.lines, 2);
    const edges = Object.fromEntries(dependencyPairs(b.lines, 2).map(([n, r]) => [n, `${n}@${r}`]));
    for (const d of descriptors) {
      const own = packageName(d);
      const alias = d.slice(own.length + 1).replace(/^npm:/, '');
      const actual = alias.includes('@') ? packageName(alias) : own;
      records.set(d, {
        name: own,
        dependencies: Object.values(edges),
        edges,
        data,
        identity: lockedIdentity(actual, data.version, data.integrity ?? data.checksum, data),
      });
    }
  }
  // A dependency names a descriptor; `a@npm:b@^1` is how an alias is written on both sides.
  for (const record of records.values()) {
    for (const [name, key] of Object.entries(record.edges))
      if (!key || !records.has(key)) record.edges[name] = undefined;
    record.dependencies = record.dependencies.filter((d) => records.has(d));
  }
  for (const edges of Object.values(roots))
    for (const [name, key] of Object.entries(edges))
      if (!key || !records.has(key)) edges[name] = undefined;
  return { records, metadata, roots };
}

/**
 * pnpm names a package that has the target as a peer after the target's version:
 * `plugin@1.2.0(target@3.0.0)`, in snapshot keys and wherever an importer or a dependent
 * points at it. Upgrading the target renames every one of them, and nothing about those
 * packages changed: the suffix is the target's version as its dependents see it. It is
 * compared without the version, so a renamed dependent is the same entry.
 */
function withoutTargetPeerVersion(text: string, target: Targets): string {
  let out = text;
  for (const each of targetNames(target)) {
    const name = each.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`\\(${name}@[^()]+\\)`, 'g'), `(${each}@*)`);
  }
  return out;
}

export function pnpmGraph(raw: string, target: Targets): LockGraph {
  const lock = parseYaml(withoutTargetPeerVersion(raw, target));
  if (!lock || typeof lock !== 'object' || Array.isArray(lock) || !lock.lockfileVersion)
    throw new UptideError('UNSUPPORTED_LOCKFILE', 'Invalid pnpm lockfile');
  const { packages = {}, snapshots = {}, ...metadata } = lock;
  const records = new Map<string, LockRecord>();
  const locator = (name: string, version: string) =>
    /^(?:@[^/()]+\/)?[^@/()]+@/.test(version) ? version : `${name}@${version}`;
  for (const [section, entries] of [
    ['packages', packages],
    ['snapshots', snapshots],
  ] as const) {
    for (const [key, value] of Object.entries(entries)) {
      const data = (value ?? {}) as Record<string, unknown>;
      const clean = key.replace(/^\//, '');
      const name = packageName(clean);
      if (
        !clean.includes('@', clean.startsWith('@') ? 1 : 0) ||
        typeof value !== 'object' ||
        Array.isArray(value)
      )
        throw new UptideError('UNSUPPORTED_LOCKFILE', `Invalid pnpm entry ${key}`);
      const base = clean.replace(/\(.*$/, '');
      const content =
        section === 'snapshots' ? (packages[base] ?? packages[`/${base}`] ?? {}) : data;
      const identity = { ...content, ...data };
      const edges: Record<string, string | undefined> = {};
      for (const field of ['dependencies', 'optionalDependencies'])
        for (const [n, v] of Object.entries((data[field] ?? {}) as object)) {
          if (typeof v !== 'string')
            throw new UptideError('UNSUPPORTED_LOCKFILE', `Cannot resolve pnpm dependency ${n}`);
          edges[n] = `${lock.snapshots === undefined ? 'packages' : 'snapshots'}:${locator(n, v)}`;
        }
      if (section === 'snapshots') edges['#package'] = `packages:${base}`;
      records.set(`${section}:${clean}`, {
        name,
        data: targetNames(target).includes(name) ? data : withoutTarget(data, target),
        edges,
        dependencies: [],
        identity: lockedIdentity(
          name,
          base.slice(name.length + 1),
          (identity.resolution as { integrity?: unknown } | undefined)?.integrity,
          identity,
        ),
      });
    }
  }
  for (const record of records.values()) {
    for (const [name, key] of Object.entries(record.edges))
      if (!key || !records.has(key)) record.edges[name] = undefined;
    record.dependencies = Object.values(record.edges).filter((k): k is string => k !== undefined);
  }
  // Importer specs and manager settings remain protected independently of package metadata.
  if (metadata.importers)
    for (const [name, importer] of Object.entries(metadata.importers))
      metadata.importers[name] = withoutTarget(importer as Record<string, unknown>, target);
  if (metadata.catalogs)
    for (const catalog of Object.values(metadata.catalogs))
      for (const name of targetNames(target)) delete (catalog as Record<string, unknown>)[name];
  return { records, metadata };
}
