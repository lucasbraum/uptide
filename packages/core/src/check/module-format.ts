import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ts } from 'ts-morph';
import { resolveEntryPoints } from '../adapters/typescript/entry-points.js';
import type { Change } from '../domain/change.js';
import { parseVersion } from './version.js';

/**
 * The declaration diff cannot see a package go ESM-only: the exports are the same names,
 * loaded a different way. The manifests can. A `require()` of a package whose target no
 * longer offers a CommonJS entry breaks at load time, unless the repository's Node
 * supports `require(esm)` (22.12+, or 20.19+) and the shape survives: named exports come
 * back as the namespace, a default export needs `.default`.
 */
export interface Manifest {
  name?: string;
  version?: string;
  type?: string;
  main?: string;
  module?: string;
  types?: string;
  typings?: string;
  exports?: unknown;
  engines?: { node?: string };
}

export type RequireEsm = 'yes' | 'no' | 'unknown';

export function readManifest(dir: string): Manifest | undefined {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Manifest;
  } catch {
    return undefined;
  }
}

function fileSupportsRequire(file: string, type: string | undefined): boolean {
  if (file.endsWith('.cjs')) return true;
  if (file.endsWith('.mjs')) return false;
  return type !== 'module';
}

/** Any target under a conditions object, following Node's shape; `require` anywhere means yes. */
function exportsSupportRequire(value: unknown, type: string | undefined): boolean {
  if (typeof value === 'string') return fileSupportsRequire(value, type);
  if (Array.isArray(value)) return value.some((v) => exportsSupportRequire(v, type));
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if ('require' in record && record.require !== null) return true;
  return Object.entries(record).some(
    ([key, v]) => key !== 'import' && key !== 'types' && exportsSupportRequire(v, type),
  );
}

/** Whether `require('<name>')` resolves to something loadable as CommonJS. */
export function supportsRequire(m: Manifest): boolean {
  if (m.exports !== undefined && m.exports !== null) {
    const record = m.exports as Record<string, unknown>;
    const root =
      typeof m.exports === 'object' &&
      !Array.isArray(m.exports) &&
      Object.keys(record).some((k) => k.startsWith('.'))
        ? record['.']
        : m.exports;
    return exportsSupportRequire(root, m.type);
  }
  return fileSupportsRequire(m.main ?? 'index.js', m.type);
}

/**
 * Whether a package directory ships declarations a compiler would find: a `types` field, a
 * `types` condition, or a `.d.ts` next to an entry (uuid 11 declares none of the first two
 * and ships `dist/cjs/index.d.ts`), the same rules the surface extraction applies.
 */
export function shipsTypes(dir: string, m: Manifest | undefined = readManifest(dir)): boolean {
  if (!m) return false;
  if (m.types || m.typings) return true;
  if (existsSync(join(dir, 'index.d.ts'))) return true;
  if (/"types"/.test(JSON.stringify(m.exports ?? {}))) return true;
  try {
    resolveEntryPoints(dir, m.name ?? '', m.version ?? '');
    return true;
  } catch {
    return false;
  }
}

/** The lowest version a range admits, or undefined when it cannot be read. */
export function minimumVersion(range: string): string | undefined {
  let lowest: string | undefined;
  for (const alternative of range.split('||')) {
    const first = alternative.trim().split(/\s+/)[0] ?? '';
    if (first.startsWith('<')) continue;
    const m = /^(?:>=|>|\^|~|=)?v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?/.exec(first);
    if (!m) continue;
    const version = `${m[1]}.${/\d/.test(m[2] ?? '') ? m[2] : 0}.${/\d/.test(m[3] ?? '') ? m[3] : 0}`;
    if (lowest === undefined || compare(version, lowest) < 0) lowest = version;
  }
  return lowest;
}

function compare(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  return pa.major - pb.major || pa.minor - pb.minor || pa.patch - pb.patch;
}

/**
 * Whether every Node the range admits can `require()` an ES module (22.12+, or 20.19 to
 * 20.x). A bare major (`node-version: 22`, `FROM node:22`, `.nvmrc` "22", `>=22`) means the
 * latest release of that major, which for 20 and 22 has it; only an explicit older minor
 * (22.11, 20.18) rules it out.
 */
export function requireEsmSupport(range: string | undefined): RequireEsm {
  if (!range) return 'unknown';
  const min = minimumVersion(range);
  if (!min) return 'unknown';
  const v = parseVersion(min);
  if (!v) return 'unknown';
  if (v.major >= 23) return 'yes';
  if (isBareMajor(range)) return v.major === 22 || v.major === 20 ? 'yes' : 'no';
  if (v.major === 22) return v.minor >= 12 ? 'yes' : 'no';
  if (v.major === 20) return v.minor >= 19 ? 'yes' : 'no';
  return 'no';
}

/** `22`, `>=22`, `^22`, `22.x`: the lowest alternative names no minor. */
export function isBareMajor(range: string): boolean {
  const min = minimumVersion(range);
  if (!min) return false;
  for (const alternative of range.split('||')) {
    const first = alternative.trim().split(/\s+/)[0] ?? '';
    const m = /^(?:>=|>|\^|~|=)?v?(\d+)(?:\.(\d+|x|\*))?/.exec(first);
    if (!m) continue;
    if (`${m[1]}.${/\d/.test(m[2] ?? '') ? m[2] : 0}` !== min.replace(/\.\d+$/, '')) continue;
    return m[2] === undefined || !/\d/.test(m[2]);
  }
  return false;
}

export interface NodeVersion {
  range: string;
  /** Where it was read: `docker/Dockerfile`, `.nvmrc`, `.github/workflows/ci.yml`, `package.json engines.node`. */
  source: string;
  /** The production image builds on a custom base: its Node is unknown, and `source` is the next best thing. */
  caveat?: string;
}

function readIf(path: string): string | undefined {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The Node the repository actually runs, in order of how binding the source is: the image
 * it ships in (`FROM node:22.14`), the version manager file, the CI matrix, and only then
 * the range it declares for others. Each candidate says where it came from.
 */
export function resolveNodeVersion(dirs: string[]): NodeVersion | undefined {
  for (const dir of dirs) {
    const dockerfiles = [
      'Dockerfile',
      'docker/Dockerfile',
      'Dockerfile.prod',
      'Dockerfile.production',
    ];
    for (const candidate of readdirSafe(dir)) {
      if (/^Dockerfile/.test(candidate) && !dockerfiles.includes(candidate))
        dockerfiles.push(candidate);
    }
    let caveat: string | undefined;
    for (const rel of dockerfiles) {
      const text = readIf(join(dir, rel));
      if (!text) continue;
      const m = /^FROM\s+(?:--platform=\S+\s+)?(?:[\w.-]+\/)?node:(\d+(?:\.\d+){0,2})/im.exec(text);
      if (m) return { range: m[1] as string, source: rel };
      const custom = /^FROM\s+(?:--platform=\S+\s+)?(\S+)/im.exec(text);
      if (custom && caveat === undefined)
        caveat = `production Node unknown: ${rel} uses a custom base image (${custom[1]})`;
    }
    const found = resolveNodeVersionFrom(dir);
    if (found) return caveat ? { ...found, caveat } : found;
  }
  return undefined;
}

/** The version manager file, the CI matrix, then the range declared for others. */
function resolveNodeVersionFrom(dir: string): NodeVersion | undefined {
  for (const file of ['.nvmrc', '.node-version']) {
    const text = readIf(join(dir, file))?.trim().replace(/^v/, '');
    if (text && !/^(lts|node|latest)/i.test(text)) return { range: text, source: file };
  }
  const tool = readIf(join(dir, '.tool-versions'));
  const toolMatch = tool ? /^nodejs\s+(\S+)/m.exec(tool) : null;
  if (toolMatch) return { range: toolMatch[1] as string, source: '.tool-versions' };
  const workflows = join(dir, '.github/workflows');
  for (const wf of readdirSafe(workflows).sort()) {
    if (!/\.ya?ml$/.test(wf)) continue;
    const text = readIf(join(workflows, wf)) ?? '';
    const m = /node-version:\s*['"]?(\d+(?:\.\d+){0,2})['"]?\s*$/m.exec(text);
    if (m) return { range: m[1] as string, source: `.github/workflows/${wf}` };
  }
  const engines = readManifest(dir)?.engines?.node;
  if (engines) return { range: engines, source: 'package.json engines.node' };
  return undefined;
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * Whether the target's own ES modules await at top level: `require(esm)` of such a graph
 * throws ERR_REQUIRE_ASYNC_MODULE whatever the shape. Bounded scan of the package's .js/.mjs.
 */
export function hasTopLevelAwait(dir: string, budget = 300): boolean {
  const files: string[] = [];
  const walk = (d: string, depth: number): void => {
    if (files.length >= budget || depth > 6) return;
    for (const entry of readdirSafe(d)) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      const full = join(d, entry);
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) walk(full, depth + 1);
      else if (/\.(m?js)$/.test(entry) && !/\.cjs$/.test(entry)) files.push(full);
      if (files.length >= budget) return;
    }
  };
  walk(dir, 0);
  for (const file of files) {
    const text = readIf(file);
    if (!text || !/\bawait\b/.test(text)) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, false, ts.ScriptKind.JS);
    let found = false;
    const visit = (n: ts.Node): void => {
      if (found || ts.isFunctionLike(n) || ts.isClassLike(n)) return;
      if (ts.isAwaitExpression(n) || (ts.isForOfStatement(n) && n.awaitModifier)) found = true;
      else ts.forEachChild(n, visit);
    };
    ts.forEachChild(sf, visit);
    if (found) return true;
  }
  return false;
}

/** The repository's Node version, from `.nvmrc`, `.node-version` or `engines.node`, nearest first. */
export function repoNodeRange(dirs: string[]): string | undefined {
  for (const dir of dirs) {
    for (const file of ['.nvmrc', '.node-version']) {
      const p = join(dir, file);
      if (existsSync(p)) {
        const text = readFileSync(p, 'utf8').trim().replace(/^v/, '');
        if (text && !/^(lts|node|latest)/i.test(text))
          return /^\d+$/.test(text) ? `>=${text}.0.0 <${Number(text) + 1}` : text;
      }
    }
    const engines = readManifest(dir)?.engines?.node;
    if (engines) return engines;
  }
  return undefined;
}

/** A `module-format` change when the target stops supporting `require()`; nothing otherwise. */
export function moduleFormatChange(
  before: Manifest,
  after: Manifest,
  meta: { package: string; from: string; to: string },
  node: {
    range: string | undefined;
    support: RequireEsm;
    source?: string;
    topLevelAwait?: boolean;
  },
): Change | undefined {
  if (!supportsRequire(before) || supportsRequire(after)) return undefined;
  const why =
    after.type === 'module'
      ? `"type": "module" and ${after.exports !== undefined ? 'no require condition in exports' : `an ESM main (${after.main ?? 'index.js'})`}`
      : 'no CommonJS entry';
  const bare =
    node.range !== undefined && isBareMajor(node.range) ? ', read as its latest release' : '';
  const where = node.source ? ` (${node.source}${bare})` : bare ? ` (${bare.slice(2)})` : '';
  const nodeClause =
    node.support === 'yes'
      ? node.topLevelAwait
        ? `Node ${node.range}${where} supports require(esm), but the target awaits at top level, which require() cannot load (ERR_REQUIRE_ASYNC_MODULE)`
        : `Node ${node.range}${where} supports require(esm): require() returns the module namespace`
      : node.support === 'no'
        ? `Node ${node.range}${where} does not guarantee require(esm) (needs 22.12+ or 20.19+)`
        : 'Node version unknown (no Dockerfile FROM node, .nvmrc, .node-version, .tool-versions, CI node-version or engines.node), so require(esm) cannot be assumed';
  const engines =
    after.engines?.node && after.engines.node !== before.engines?.node
      ? `; requires Node ${after.engines.node}`
      : '';
  return {
    ...meta,
    path: '.',
    kind: 'module-format',
    severity: 'breaking',
    source: 'types',
    confidence: 1,
    evidence: 'checker',
    before: 'loadable with require()',
    after: 'ESM only',
    notes: `no longer loadable with require(): ${why}; ${nodeClause}${engines}`,
    requireEsm: node.support,
    ...(node.topLevelAwait ? { topLevelAwait: true } : {}),
  };
}
