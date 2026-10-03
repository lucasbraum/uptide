import { typescriptAdapter } from './adapters/typescript/index.js';
import { createFsSurfaceCache } from './cache/fs-surface-cache.js';
import { classify } from './diff/classify.js';
import { rawDiff, sortByPath } from './diff/diff.js';
import { refineWithTypes } from './diff/refine.js';
import type { LanguageAdapter, PackageDir } from './domain/adapter.js';
import type { Change } from './domain/change.js';
import type { PackageFetcher, SurfaceCache } from './domain/io.js';
import { type ApiSurface, SURFACE_SCHEMA_VERSION } from './domain/surface.js';
import { createNpmFetcher, releasePackage } from './fetch/npm-fetcher.js';

export interface SurfaceOptions {
  adapter?: LanguageAdapter;
  fetcher?: PackageFetcher;
  cache?: SurfaceCache;
}

export interface DiffPackageOptions extends SurfaceOptions {
  name: string;
  from: string;
  to: string;
  /** Refine textual differences with the adapter's type checker. Default true. */
  assignability?: boolean;
}

let defaultFetcher: PackageFetcher | undefined;
let defaultCache: SurfaceCache | undefined;

/** Built once per process: the fetcher reads .npmrc and the cache resolves its directory. */
function defaults(): { fetcher: PackageFetcher; cache: SurfaceCache } {
  defaultFetcher ??= createNpmFetcher();
  defaultCache ??= createFsSurfaceCache();
  return { fetcher: defaultFetcher, cache: defaultCache };
}

async function surfaceOfDir(
  pkg: PackageDir,
  adapter: LanguageAdapter,
  cache: SurfaceCache,
): Promise<ApiSurface> {
  const key = {
    package: pkg.name,
    version: pkg.version,
    adapter: adapter.id,
    schema: SURFACE_SCHEMA_VERSION,
  };
  const cached = await cache.get(key);
  if (cached) return cached;
  const surface = await adapter.extractSurface(pkg);
  await cache.set(key, surface);
  return surface;
}

/**
 * The surface of one package version, from cache when the adapter and schema match. The
 * extracted package directory only lives for the duration of the extraction.
 */
export async function surfaceOf(
  name: string,
  version: string,
  opts: SurfaceOptions = {},
): Promise<ApiSurface> {
  const adapter = opts.adapter ?? typescriptAdapter;
  const fetcher = opts.fetcher ?? defaults().fetcher;
  const cache = opts.cache ?? defaults().cache;
  const key = { package: name, version, adapter: adapter.id, schema: SURFACE_SCHEMA_VERSION };
  const cached = await cache.get(key);
  if (cached) return cached;
  const pkg = await fetcher.fetch(name, version);
  try {
    return await surfaceOfDir(pkg, adapter, cache);
  } finally {
    await releasePackage(fetcher, pkg);
  }
}

/**
 * Both package directories stay on disk until the diff is done: the type checker needs
 * them even when both surfaces come from the cache.
 */
export interface DetailedDiff {
  surfaceA: ApiSurface;
  surfaceB: ApiSurface;
  changes: Change[];
}

export async function diffPackage(opts: DiffPackageOptions): Promise<Change[]> {
  return (await diffPackageDetailed(opts)).changes;
}

export async function diffPackageDetailed(opts: DiffPackageOptions): Promise<DetailedDiff> {
  const fetcher = opts.fetcher ?? defaults().fetcher;
  const [pkgA, pkgB] = await Promise.all([
    fetcher.fetch(opts.name, opts.from),
    fetcher.fetch(opts.name, opts.to),
  ]);
  try {
    return await diffDirs(pkgA, pkgB, opts);
  } finally {
    await Promise.all([pkgA, pkgB].map((p) => releasePackage(fetcher, p)));
  }
}

export interface DiffDirsOptions extends SurfaceOptions {
  assignability?: boolean;
  /** Compare only these paths of the old surface (a consumer's used symbols, their ancestors and members). */
  onlyPaths?: Set<string>;
}

function restrict(surface: ApiSurface, only: Set<string> | undefined): ApiSurface {
  return only ? { ...surface, symbols: surface.symbols.filter((s) => only.has(s.path)) } : surface;
}

/**
 * The diff between two extracted package directories. The caller owns the directories:
 * `check` diffs the copy installed in the consumer's node_modules against a fetched
 * target and must not delete the former.
 */
export async function diffDirs(
  pkgA: PackageDir,
  pkgB: PackageDir,
  opts: DiffDirsOptions = {},
): Promise<DetailedDiff> {
  const adapter = opts.adapter ?? typescriptAdapter;
  const cache = opts.cache ?? defaults().cache;
  const [fullA, fullB] = await Promise.all([
    surfaceOfDir(pkgA, adapter, cache),
    surfaceOfDir(pkgB, adapter, cache),
  ]);
  // Only the old side is restricted: what the consumer uses bounds what can affect it, while the
  // new side stays whole so removals can still be recognised as moves and additions stay cheap.
  const a = restrict(fullA, opts.onlyPaths);
  const b = fullB;
  let raw = rawDiff(a, b);
  if (opts.assignability !== false && adapter.compareTypes) {
    const paths = [
      ...new Set(raw.filter((c) => c.kind === 'signature' || c.kind === 'type').map((c) => c.path)),
    ];
    if (paths.length > 0) {
      const comparisons = await adapter.compareTypes({
        a: pkgA,
        b: pkgB,
        surfaceA: a,
        surfaceB: b,
        paths,
      });
      raw = refineWithTypes(raw, comparisons, b);
    }
  }
  return { surfaceA: a, surfaceB: b, changes: sortByPath(classify(raw)) };
}
