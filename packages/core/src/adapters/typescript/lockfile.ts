import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

/**
 * Installed versions come from the lockfile, never from node_modules alone: a lockfile
 * is what the team agreed on, node_modules is what one machine happens to have. In a
 * workspace the lockfile sits at the root and records each package (importer) separately;
 * the importer being checked is the one read.
 */

export type LockfileKind = 'pnpm' | 'npm' | 'yarn' | 'bun';

export interface Lockfile {
  kind: LockfileKind;
  file: string;
  /** Importer read, relative to the lockfile's directory (`.` for the root). */
  importer: string;
  /** name -> exact installed version, for that importer's direct dependencies. */
  installed: Map<string, string>;
}

export interface LockfileQuery {
  /** Importer path relative to the lockfile directory, POSIX separators, `.` for the root. */
  importer: string;
  /** name -> declared range from the importer's package.json (yarn and bun key entries by range). */
  declared: Map<string, string>;
}

const CANDIDATES: [string, LockfileKind][] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['package-lock.json', 'npm'],
  ['npm-shrinkwrap.json', 'npm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
];

/** The nearest lockfile in `dir` or an ancestor: a workspace keeps one at its root. */
export function findLockfile(
  dir: string,
): { file: string; kind: LockfileKind; dir: string } | undefined {
  let current = dir;
  for (;;) {
    for (const [name, kind] of CANDIDATES) {
      const file = join(current, name);
      if (existsSync(file)) return { file, kind, dir: current };
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export function readLockfile(
  packageDir: string,
  declared: Map<string, string>,
): Lockfile | undefined {
  const found = findLockfile(packageDir);
  if (!found) return undefined;
  const importer = relative(found.dir, packageDir).split('\\').join('/') || '.';
  const text = readFileSync(found.file, 'utf8');
  const query: LockfileQuery = { importer, declared };
  const installed =
    found.kind === 'pnpm'
      ? parsePnpm(text, query)
      : found.kind === 'npm'
        ? parseNpm(text, query)
        : found.kind === 'yarn'
          ? parseYarn(text, query)
          : parseBun(text, query);
  return { kind: found.kind, file: found.file, importer, installed };
}

/**
 * package-lock v2/v3: `packages["<importer>/node_modules/<name>"]` when the workspace
 * package has its own copy, else the hoisted `packages["node_modules/<name>"]`; v1:
 * `dependencies[<name>].version`.
 */
export function parseNpm(text: string, query: LockfileQuery): Map<string, string> {
  const out = new Map<string, string>();
  const lock = JSON.parse(text) as {
    packages?: Record<string, { version?: string }>;
    dependencies?: Record<string, { version?: string }>;
  };
  for (const name of query.declared.keys()) {
    const nested =
      query.importer === '.'
        ? undefined
        : lock.packages?.[`${query.importer}/node_modules/${name}`]?.version;
    const v =
      nested ??
      lock.packages?.[`node_modules/${name}`]?.version ??
      lock.dependencies?.[name]?.version;
    if (v) out.set(name, v);
  }
  return out;
}

/**
 * pnpm-lock v6+: `importers: { <importer>: { dependencies: { name: { version } } } }`;
 * v5: top-level `dependencies: { name: version }` for single-package repos.
 */
export function parsePnpm(text: string, query: LockfileQuery): Map<string, string> {
  const out = new Map<string, string>();
  const names = new Set(query.declared.keys());
  let section: 'none' | 'importers' | 'top-deps' = 'none';
  let inWanted = false;
  let inDeps = false;
  let pendingDep: string | undefined;
  const isWantedImporter = (key: string): boolean =>
    key.replace(/^['"]|['"]$/g, '') === query.importer;
  for (const line of text.split('\n')) {
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    if (indent === 0) {
      section =
        trimmed === 'importers:'
          ? 'importers'
          : trimmed === 'dependencies:' || trimmed === 'devDependencies:'
            ? 'top-deps'
            : 'none';
      inWanted = false;
      inDeps = false;
      pendingDep = undefined;
      continue;
    }
    if (section === 'importers') {
      if (indent === 2) {
        inWanted = isWantedImporter(trimmed.replace(/:$/, ''));
        inDeps = false;
        continue;
      }
      if (!inWanted) continue;
      if (indent === 4) {
        inDeps =
          trimmed === 'dependencies:' ||
          trimmed === 'devDependencies:' ||
          trimmed === 'optionalDependencies:';
        pendingDep = undefined;
        continue;
      }
      if (!inDeps) continue;
      if (indent === 6) {
        const m = /^['"]?(@?[^'":]+)['"]?:\s*(.*)$/.exec(trimmed);
        if (!m) continue;
        const name = m[1] as string;
        const inline = (m[2] ?? '').trim();
        pendingDep = names.has(name) ? name : undefined;
        if (pendingDep && inline) out.set(name, cleanPnpmVersion(inline));
      } else if (indent === 8 && pendingDep) {
        const m = /^version:\s*(.+)$/.exec(trimmed);
        if (m) out.set(pendingDep, cleanPnpmVersion(m[1] as string));
      }
      continue;
    }
    if (section === 'top-deps' && query.importer === '.') {
      if (indent === 2) {
        const m = /^['"]?(@?[^'":]+)['"]?:\s*(.*)$/.exec(trimmed);
        if (!m) continue;
        const name = m[1] as string;
        const inline = (m[2] ?? '').trim();
        pendingDep = names.has(name) ? name : undefined;
        if (pendingDep && inline) out.set(name, cleanPnpmVersion(inline));
      } else if (indent === 4 && pendingDep) {
        const m = /^version:\s*(.+)$/.exec(trimmed);
        if (m) out.set(pendingDep, cleanPnpmVersion(m[1] as string));
      }
    }
  }
  return out;
}

/** `1.2.3(react@18)` (v6+) and `1.2.3_react@18` (v5) both carry peer suffixes after the version. */
function cleanPnpmVersion(v: string): string {
  return v.replace(/^['"]|['"]$/g, '').replace(/[(_].*$/, '');
}

/**
 * yarn keys entries by `name@range`, so the importer's declared range selects its entry:
 * v1 `"name@^1.0.0":` then `  version "1.2.3"`; berry `"name@npm:^1.0.0":` then
 * `  version: 1.2.3`. Without a matching range the first entry for the name is used.
 */
export function parseYarn(text: string, query: LockfileQuery): Map<string, string> {
  const byRange = new Map<string, string>();
  const first = new Map<string, string>();
  let currentSpecs: { name: string; range: string }[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '' || line.startsWith('#')) continue;
    if (!line.startsWith(' ')) {
      const header = line.replace(/:\s*$/, '');
      currentSpecs = header.split(',').map((part) => {
        const spec = part.trim().replace(/^"|"$/g, '');
        const at = spec.startsWith('@') ? spec.indexOf('@', 1) : spec.indexOf('@');
        const name = at === -1 ? spec : spec.slice(0, at);
        const range = at === -1 ? '' : spec.slice(at + 1).replace(/^npm:/, '');
        return { name, range };
      });
      continue;
    }
    const m = /^\s+version:?\s+"?([^"\s]+)"?/.exec(line);
    if (!m) continue;
    for (const { name, range } of currentSpecs) {
      byRange.set(`${name}@${range}`, m[1] as string);
      if (!first.has(name)) first.set(name, m[1] as string);
    }
  }
  const out = new Map<string, string>();
  for (const [name, range] of query.declared) {
    const v = byRange.get(`${name}@${range}`) ?? first.get(name);
    if (v) out.set(name, v);
  }
  return out;
}

/**
 * bun.lock (text, JSONC): `packages: { "<name>": ["<name>@<version>", ...] }`, with a
 * nested key `"<workspace>/<name>"` when a workspace package has its own copy. The
 * binary bun.lockb is not read.
 */
export function parseBun(text: string, query: LockfileQuery): Map<string, string> {
  const out = new Map<string, string>();
  const jsonish = text.replace(/,\s*([}\]])/g, '$1');
  let lock: {
    packages?: Record<string, unknown[]>;
    workspaces?: Record<string, { name?: string }>;
  };
  try {
    lock = JSON.parse(jsonish) as typeof lock;
  } catch {
    return out;
  }
  const workspaceName =
    query.importer === '.' ? undefined : lock.workspaces?.[query.importer]?.name;
  for (const name of query.declared.keys()) {
    const nested = workspaceName ? lock.packages?.[`${workspaceName}/${name}`]?.[0] : undefined;
    const entry = nested ?? lock.packages?.[name]?.[0];
    if (typeof entry !== 'string') continue;
    const at = entry.startsWith('@') ? entry.indexOf('@', 1) : entry.indexOf('@');
    if (at !== -1) out.set(name, entry.slice(at + 1));
  }
  return out;
}
