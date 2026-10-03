import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { defaultCacheDir, packagePathSegments } from '../cache/paths.js';
import type { RuntimeChange, RuntimeDiff, RuntimeLoad, RuntimeSurface } from '../domain/runtime.js';
import { PROBE_SOURCE } from './probe.js';

export interface ProbeOptions {
  /** The consumer's `node_modules`: every entry except the package itself is linked into the sandbox. */
  dependenciesFrom: string;
  /** The repository's Node range (`22`, `>=20.19`). Decides which local Node runs the probe. */
  nodeRange?: string;
  cacheDir?: string;
  /** Overrides Node binary discovery (tests). */
  nodeBinary?: string;
  /** Skips the cache (tests). */
  noCache?: boolean;
  /** Package name → directory, linked over the consumer's copies (the target's own dependency versions). */
  extraLinks?: Record<string, string>;
  /**
   * Provides a dependency the sandbox lacks, at the range its importer declares: a directory
   * to link, or nothing. The probe retries with it, so a target whose dependencies are newer
   * than the consumer's still loads. Only the npm registry is ever consulted for this.
   */
  resolveDependency?: (dep: string, range: string) => Promise<string | undefined>;
  /**
   * Link every entry of `dependenciesFrom` by name (default). `false` for a target copy: its
   * dependencies are resolved through `resolveDependency` at the ranges it declares, so a
   * consumer copy too old for it never shadows the right one.
   */
  linkConsumer?: boolean;
}

interface Manifest {
  name?: string;
  version?: string;
  gypfile?: boolean;
  binary?: unknown;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

const PROBE_TIMEOUT_MS = 15_000;
const CACHE_SCHEMA = 2;

/**
 * Loads one copy of a package with `require()` and `import()` in a child Node with the permission
 * model on: no file writes, no child processes, no workers, no native addons. Install scripts are
 * never run; the package is linked as it is on disk. Node has no switch for the network, so the
 * child also gets a preload that makes every socket connect throw. Results are cached per
 * package@version and Node major.
 */
export async function probeRuntime(
  packageDir: string,
  opts: ProbeOptions,
): Promise<RuntimeSurface> {
  const manifest = readManifest(packageDir);
  const name = manifest?.name ?? 'unknown';
  const version = manifest?.version ?? '0.0.0';
  const node = chooseNode(opts.nodeRange, opts.nodeBinary);
  const cacheDir = opts.cacheDir ?? defaultCacheDir();
  const cacheFile = join(
    cacheDir,
    'runtime',
    ...packagePathSegments(name),
    `${version}-node${node.major}.json`,
  );
  if (!opts.noCache && existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(readFileSync(cacheFile, 'utf8')) as {
        schema: number;
        surface: RuntimeSurface;
      };
      if (
        cached.schema === CACHE_SCHEMA &&
        cached.surface.package === name &&
        cached.surface.version === version
      ) {
        return { ...cached.surface, nodeSource: node.source };
      }
    } catch {
      // A damaged cache entry is just re-probed.
    }
  }
  const base = {
    package: name,
    version,
    node: node.version,
    nodeSource: node.source,
    require: { ok: false } as RuntimeLoad,
    import: { ok: false } as RuntimeLoad,
  };
  const native = looksNative(manifest);
  const surface: RuntimeSurface = native
    ? { ...base, inconclusive: native }
    : await probeWithDependencies(name, packageDir, node, opts, base);
  if (!opts.noCache) {
    try {
      mkdirSync(dirname(cacheFile), { recursive: true });
      // Dependency failures can be repaired without changing the package version.
      if (!surface.inconclusive || looksNative(manifest)) {
        const temporary = `${cacheFile}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
        writeFileSync(temporary, JSON.stringify({ schema: CACHE_SCHEMA, surface }));
        renameSync(temporary, cacheFile);
      }
    } catch {
      // The cache is an optimisation only.
    }
  }
  return surface;
}

const MAX_DEPENDENCY_ROUNDS = 40;

/**
 * Runs the probe, and when a load failed on a dependency the sandbox could not provide, asks
 * for it at the range its importer declares and runs again. One missing package per round;
 * a target that needs several newer dependencies takes several rounds.
 */
async function probeWithDependencies(
  name: string,
  packageDir: string,
  node: ChosenNode,
  opts: ProbeOptions,
  base: Omit<RuntimeSurface, 'inconclusive'>,
): Promise<RuntimeSurface> {
  const links = { ...(opts.extraLinks ?? {}) };
  const tried = new Set<string>(Object.keys(links));
  const consumer = opts.linkConsumer === false ? undefined : opts.dependenciesFrom;
  // Every placed package brings its declared dependencies along before the next run, so the
  // rounds follow the depth of the tree, not its size.
  const bring = async (dir: string): Promise<boolean> => {
    if (!opts.resolveDependency) return true;
    const m = readManifest(dir);
    for (const [dep, range] of Object.entries({ ...m?.peerDependencies, ...m?.dependencies })) {
      if (dep === name || tried.has(dep)) continue;
      tried.add(dep);
      const found = await opts.resolveDependency(dep, range).catch(() => undefined);
      if (found) links[dep] = found;
    }
    return true;
  };
  if (consumer === undefined) await bring(packageDir);
  for (let round = 0; round < MAX_DEPENDENCY_ROUNDS; round++) {
    const result = runProbe(name, packageDir, node, consumer, links, base);
    const missing = missingDependency(name, result);
    if (!missing || !opts.resolveDependency) return result;
    if (tried.has(missing.dep) && links[missing.dep] === undefined) {
      return {
        ...result,
        inconclusive: `dependency "${missing.dep}@${missing.range}" could not be provided to the probe`,
      };
    }
    tried.add(missing.dep);
    const dir =
      links[missing.dep] ??
      (await opts.resolveDependency(missing.dep, missing.range).catch(() => undefined));
    if (!dir) {
      return {
        ...result,
        inconclusive: `dependency "${missing.dep}@${missing.range}" could not be provided to the probe`,
      };
    }
    if (links[missing.dep] === undefined) {
      links[missing.dep] = dir;
      await bring(dir);
    } else {
      // Linked and still missing: a subpath the linked version does not have.
      return result;
    }
  }
  return runProbe(name, packageDir, node, consumer, links, base);
}

/** The package a failed load was missing, and the range the importer declares for it (`*` when it does not). */
function missingDependency(
  name: string,
  result: RuntimeSurface,
): { dep: string; range: string } | undefined {
  for (const load of [result.require, result.import]) {
    if (load.ok || !load.missing) continue;
    const dep = packageNameOf(missingPackage(load.missing));
    if (dep === name || dep.startsWith('.') || dep.startsWith('/') || dep.startsWith('node:'))
      continue;
    const range = load.missingRange ?? '*';
    return { dep, range };
  }
  return undefined;
}

/** `strtok3/core` -> `strtok3`; `@scope/pkg/sub` -> `@scope/pkg`. */
function packageNameOf(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier);
}

function nearestManifestDir(dir: string): string | undefined {
  let current = dir;
  for (let i = 0; i < 20; i++) {
    if (existsSync(join(current, 'package.json'))) return current;
    const up = dirname(current);
    if (up === current) return undefined;
    current = up;
  }
  return undefined;
}

function declaredRangeIn(dir: string, dep: string): string | undefined {
  const m = readManifest(dir);
  return m?.dependencies?.[dep] ?? m?.peerDependencies?.[dep] ?? m?.optionalDependencies?.[dep];
}

/** Native addons need a build step uptide never runs; their load says nothing about the API. */
function looksNative(manifest: Manifest | undefined): string | undefined {
  if (!manifest) return undefined;
  if (manifest.gypfile || manifest.binary) return 'native addon (gypfile/binary in package.json)';
  const scripts = manifest.scripts ?? {};
  for (const hook of ['install', 'preinstall', 'postinstall']) {
    if (scripts[hook]) return `install script "${hook}" is never run`;
  }
  const optional = Object.keys(manifest.optionalDependencies ?? {});
  if (optional.some((dep) => /^@[\w-]+\/[\w-]+-(darwin|linux|win32|android|freebsd)-/.test(dep))) {
    return 'platform-specific optional dependencies (prebuilt binaries)';
  }
  return undefined;
}

function runProbe(
  name: string,
  packageDir: string,
  node: ChosenNode,
  dependenciesFrom: string | undefined,
  extraLinks: Record<string, string>,
  base: Omit<RuntimeSurface, 'inconclusive'>,
): RuntimeSurface {
  const sandbox = mkdtempSync(join(tmpdir(), 'uptide-probe-'));
  try {
    const modules = join(sandbox, 'node_modules');
    mkdirSync(modules);
    if (dependenciesFrom !== undefined) linkDependencies(dependenciesFrom, modules, name);
    // Node resolves through real paths (pnpm's nested `.pnpm` layout needs that), so a copy that
    // lives outside the consumer's tree (a fetched target, a fetched dependency) is copied into
    // the sandbox, where the consumer's dependencies are the ones next to it.
    const tree = treeRoot(dependenciesFrom ?? resolve(packageDir));
    for (const [dep, dir] of Object.entries(extraLinks)) {
      if (dep === name) continue;
      const at = join(modules, ...packagePathSegments(dep));
      rmSync(at, { force: true, recursive: true });
      mkdirSync(dirname(at), { recursive: true });
      place(dir, at, tree);
    }
    const link = join(modules, ...packagePathSegments(name));
    mkdirSync(dirname(link), { recursive: true });
    place(resolve(packageDir), link, tree);
    writeFileSync(join(sandbox, 'probe.mjs'), PROBE_SOURCE);
    writeFileSync(join(sandbox, 'no-net.mjs'), NO_NET_SOURCE);
    // The sandbox needs no package.json: the probe is `.mjs`, and `createRequire` from a path
    // inside it resolves against `node_modules` next to it.
    const out = execFileSync(
      node.binary,
      [
        permissionFlag(node.major),
        '--allow-fs-read=*',
        '--no-warnings',
        '--import',
        join(sandbox, 'no-net.mjs'),
        join(sandbox, 'probe.mjs'),
        name,
        'both',
      ],
      {
        cwd: sandbox,
        timeout: PROBE_TIMEOUT_MS,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { PATH: process.env.PATH ?? '', HOME: sandbox, NODE_ENV: 'production' },
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    const line = out.trim().split('\n').pop() ?? '';
    const parsed = JSON.parse(line) as { require: RuntimeLoad; import: RuntimeLoad };
    // The importer's manifest lives in the sandbox, which is gone once this returns: read the
    // range it declares for the missing package now.
    for (const load of [parsed.require, parsed.import]) {
      if (load.ok || !load.missing || !load.from) continue;
      const importerDir = nearestManifestDir(dirname(load.from));
      const dep = packageNameOf(missingPackage(load.missing));
      load.missingRange = importerDir ? (declaredRangeIn(importerDir, dep) ?? '*') : '*';
    }
    const surface: RuntimeSurface = { ...base, require: parsed.require, import: parsed.import };
    const inconclusive = inconclusiveReason(name, parsed.require, parsed.import);
    return inconclusive ? { ...surface, inconclusive } : surface;
  } catch (err) {
    const message = err instanceof Error ? err.message.split('\n')[0] : String(err);
    return { ...base, inconclusive: `probe did not complete: ${message}` };
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

/**
 * A load that fails because the sandbox could not provide something is not a finding about the
 * package. Both loaders failing the same way on a missing dependency, a denied permission or a
 * native addon says nothing about the API.
 */
function inconclusiveReason(name: string, req: RuntimeLoad, imp: RuntimeLoad): string | undefined {
  for (const load of [req, imp]) {
    if (load.ok) continue;
    // A missing file inside the package itself (declarations-only fixture, broken `main`) is
    // the package's own failure, not something the sandbox withheld.
    const ownFile = load.missing?.includes(`/node_modules/${name}/`) ?? false;
    const missing = load.missing === undefined ? undefined : missingPackage(load.missing);
    if (missing && !ownFile && missing !== name && !missing.startsWith(`${name}/`)) {
      return `dependency "${missing}" not available to the probe`;
    }
    if (load.code === 'ERR_ACCESS_DENIED') return `the probe sandbox denied: ${load.message}`;
    if (load.code === 'ERR_DLOPEN_DISABLED' || load.code === 'ERR_DLOPEN_FAILED') {
      return 'native addon';
    }
  }
  // Neither loader got a value: nothing to compare. (`require()` alone failing with
  // ERR_REQUIRE_ESM is the ESM-only shape and stays a result.)
  if (!req.ok && !imp.ok) {
    return `both loaders failed: ${imp.message ?? imp.code ?? 'unknown error'}`;
  }
  return undefined;
}

/** `/tmp/x/node_modules/strtok3/core` -> `strtok3/core`; a bare specifier stays as it is. */
function missingPackage(missing: string): string {
  const at = missing.lastIndexOf('/node_modules/');
  return at < 0 ? missing : missing.slice(at + '/node_modules/'.length);
}

function linkDependencies(from: string, into: string, except: string): void {
  if (!existsSync(from)) return;
  for (const entry of readdirSync(from)) {
    if (entry.startsWith('.')) continue;
    if (entry.startsWith('@')) {
      const scopeDir = join(from, entry);
      mkdirSync(join(into, entry), { recursive: true });
      for (const inner of readdirSafe(scopeDir)) {
        if (`${entry}/${inner}` === except) continue;
        trySymlink(join(scopeDir, inner), join(into, entry, inner));
      }
      continue;
    }
    if (entry === except) continue;
    trySymlink(join(from, entry), join(into, entry));
  }
}

/** The directory whose `node_modules` tree the consumer's copies live in. */
function treeRoot(dependenciesFrom: string): string {
  const real = realpathSafe(dependenciesFrom);
  const at = real.indexOf(`${sep}node_modules`);
  return at < 0 ? real : real.slice(0, at);
}

/** A copy inside the consumer's tree is linked; one outside it is copied so its dependencies resolve. */
function place(dir: string, at: string, tree: string): void {
  const real = realpathSafe(dir);
  if (real.startsWith(`${tree}${sep}`)) symlinkSync(real, at, 'dir');
  else cpSync(real, at, { recursive: true });
}

function realpathSafe(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

function trySymlink(target: string, path: string): void {
  try {
    symlinkSync(target, path, 'dir');
  } catch {
    // A dangling or duplicate entry in the consumer's node_modules is skipped.
  }
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function readManifest(dir: string): Manifest | undefined {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Manifest;
  } catch {
    return undefined;
  }
}

/** The stable flag arrived in 22.13 / 23.5; older lines only know the experimental name. */
function permissionFlag(major: number): string {
  return major >= 23 ? '--permission' : '--experimental-permission';
}

/** Loaded before the probe: the package may be loaded, but nothing it does may reach the network. */
const NO_NET_SOURCE = `
import net from 'node:net';
import dgram from 'node:dgram';
import dns from 'node:dns';
const deny = () => { const e = new Error('network disabled by uptide probe'); e.code = 'ERR_UPTIDE_NO_NET'; throw e; };
net.Socket.prototype.connect = deny;
net.createConnection = deny;
net.connect = deny;
dgram.createSocket = deny;
for (const fn of ['lookup', 'resolve', 'resolve4', 'resolve6']) { dns[fn] = deny; dns.promises[fn] = deny; }
`;

interface ChosenNode {
  binary: string;
  version: string;
  major: number;
  source: 'repository' | 'current';
}

/** The repository's Node when a local install of that major exists; otherwise the running one. */
function chooseNode(range: string | undefined, override?: string): ChosenNode {
  const current: ChosenNode = {
    binary: override ?? process.execPath,
    version: process.version,
    major: Number(process.versions.node.split('.')[0]),
    source: 'current',
  };
  if (override) return current;
  const major = majorOf(range);
  if (major === undefined) return current;
  if (major === current.major) return { ...current, source: 'repository' };
  const found = nodeBinaryFor(major);
  return found ? { ...found, source: 'repository' } : current;
}

function majorOf(range: string | undefined): number | undefined {
  const m = range ? /(\d+)/.exec(range) : null;
  return m ? Number(m[1]) : undefined;
}

/** Looks through the common version managers for the highest installed release of a major. */
export function nodeBinaryFor(
  major: number,
  home: string = homedir(),
): Omit<ChosenNode, 'source'> | undefined {
  const roots = [
    { dir: join(home, '.nvm/versions/node'), bin: 'bin/node' },
    { dir: join(home, '.volta/tools/image/node'), bin: 'bin/node' },
    { dir: join(home, '.asdf/installs/nodejs'), bin: 'bin/node' },
    { dir: join(home, '.fnm/node-versions'), bin: 'installation/bin/node' },
    {
      dir: join(home, 'Library/Application Support/fnm/node-versions'),
      bin: 'installation/bin/node',
    },
    { dir: join(home, '.local/share/fnm/node-versions'), bin: 'installation/bin/node' },
  ];
  let best: Omit<ChosenNode, 'source'> | undefined;
  let bestKey = [-1, -1, -1];
  for (const root of roots) {
    for (const entry of readdirSafe(root.dir)) {
      const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(entry);
      if (!m || Number(m[1]) !== major) continue;
      const key = [Number(m[1]), Number(m[2]), Number(m[3])];
      const binary = join(root.dir, entry, root.bin);
      if (!existsSync(binary)) continue;
      if (compare(key, bestKey) > 0) {
        bestKey = key;
        best = { binary, version: `v${key.join('.')}`, major };
      }
    }
  }
  return best;
}

function compare(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Installed against target: what a consumer that loads the package would notice. */
export function diffRuntime(before: RuntimeSurface, after: RuntimeSurface): RuntimeDiff {
  if (before.inconclusive)
    return { changes: [], inconclusive: `installed copy: ${before.inconclusive}` };
  if (after.inconclusive)
    return { changes: [], inconclusive: `target copy: ${after.inconclusive}` };
  const changes: RuntimeChange[] = [];
  for (const loader of ['require', 'import'] as const) {
    const a = before[loader];
    const b = after[loader];
    if (a.ok && !b.ok) {
      changes.push({
        kind: loader === 'require' ? 'require-throws' : 'import-throws',
        loader,
        detail: `${loader}() now throws ${b.code ?? 'an error'}${b.message ? `: ${b.message}` : ''}`,
      });
      continue;
    }
    if (!a.ok || !b.ok) continue;
    if (a.callable && !b.callable) {
      if (b.defaultCallable) {
        changes.push({
          kind: 'namespace-instead',
          loader,
          detail: `${loader}() returned a function and now returns a namespace; the function is its \`default\``,
        });
      } else {
        changes.push({
          kind: 'callable-lost',
          loader,
          detail: `${loader}() no longer returns a callable value`,
        });
      }
    } else if (a.constructable && !b.constructable && b.callable) {
      changes.push({
        kind: 'constructable-lost',
        loader,
        detail: `${loader}() returns a function that can no longer be used with \`new\``,
      });
    }
    const afterKeys = new Set(Object.keys(b.keys ?? {}));
    const afterDefaultKeys = new Set(b.defaultKeys ?? []);
    for (const key of Object.keys(a.keys ?? {})) {
      if (afterKeys.has(key)) continue;
      if (afterDefaultKeys.has(key)) continue;
      changes.push({
        kind: 'key-removed',
        loader,
        key,
        detail: `\`${key}\` is no longer an export of ${loader}()`,
      });
    }
  }
  return { changes };
}
