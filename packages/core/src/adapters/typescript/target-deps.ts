import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PackageDir } from '../../domain/adapter.js';
import type { PackageFetcher } from '../../domain/io.js';
import { maxSatisfying, satisfies } from '../../fetch/range.js';
import type { LoadedRepo } from './repo.js';
import { resolvePackageDir } from './usages.js';

/**
 * The target tarball has no node_modules. Its own imports must still resolve to versions
 * *it* declares, not to whatever the consumer happens to have: vitest@5 type-checked
 * against the consumer's @vitest/runner@4 produces errors that are not the consumer's.
 *
 * Rule: a dependency is satisfied from the registry, at the highest version inside the
 * importing package's declared range, unless the consumer's installed copy already
 * satisfies it. Packages in the importer's own scope (`@scope/*` for `@scope/x`, `@x/*`
 * for `x`) are always resolved from the registry: they release in lockstep, and
 * "satisfies" with a loose range is not the same as "the version this build was made with".
 *
 * Only what the type declarations actually import is resolved: the overlay compile reports
 * which bare imports it met inside the target (and inside anything linked for it), those
 * are satisfied, and the compile runs again, until nothing new is wanted. A package's
 * runtime dependency graph is much larger than what its `.d.ts` files reach.
 */

interface Manifest {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

export interface DependencyLinks {
  /** Package name → directory the overlay must serve it from. */
  links: Map<string, string>;
  /** Directories fetched for this compile. They are the fetcher's to remove: a memoizing fetcher shares them across compiles. */
  fetched: PackageDir[];
  /** `name@version (fetched)` / `(consumer)` for each link, sorted. */
  linked: string[];
  /** Ranges nothing could satisfy: `name@installed does not satisfy range`. */
  unsatisfied: string[];
  /** Names already decided, whatever the outcome. */
  decided: Set<string>;
}

/** A bare import met inside the overlay that the linked packages do not serve yet. */
export interface Wanted {
  range: string;
  /** The importing package's name (its scope decides the lockstep rule). */
  from: string;
}

export function newLinks(): DependencyLinks {
  return { links: new Map(), fetched: [], linked: [], unsatisfied: [], decided: new Set() };
}

export function scopeOf(pkg: string): string {
  return pkg.startsWith('@') ? (pkg.split('/')[0] as string) : `@${pkg}`;
}

/** Pure. Whether the consumer's copy may stand in for what the importer declares. */
export function consumerCopySatisfies(
  pkg: string,
  dep: string,
  range: string,
  consumerVersion: string | undefined,
): boolean {
  if (consumerVersion === undefined) return false;
  if (dep.startsWith(`${scopeOf(pkg)}/`)) return false;
  return satisfies(consumerVersion, range);
}

// shared-state: not TS-dependent
const manifests = new Map<string, Manifest | undefined>();

export function readManifest(dir: string): Manifest | undefined {
  if (manifests.has(dir)) return manifests.get(dir);
  let manifest: Manifest | undefined;
  try {
    manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Manifest;
  } catch {
    manifest = undefined;
  }
  manifests.set(dir, manifest);
  return manifest;
}

/** The range a package at `dir` declares for `dep`, as a dependency or peer dependency. */
export function declaredRange(dir: string, dep: string): string | undefined {
  const m = readManifest(dir);
  return m?.dependencies?.[dep] ?? m?.peerDependencies?.[dep];
}

/**
 * Whether `dep` is something the package at `dir` expects its consumer to provide: a peer
 * dependency it does not also list as its own. An install gives it the consumer's copy,
 * whatever range it asks for.
 */
export function isPeerOnly(dir: string, dep: string): boolean {
  const m = readManifest(dir);
  return m?.peerDependencies?.[dep] !== undefined && m.dependencies?.[dep] === undefined;
}

export function installedVersion(
  repo: LoadedRepo,
  dep: string,
): { dir: string; version: string } | undefined {
  const dir = resolvePackageDir(repo, dep);
  if (!dir || !existsSync(join(dir, 'package.json'))) return undefined;
  const version = readManifest(dir)?.version;
  return version ? { dir, version } : undefined;
}

const EXACT = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** Links every wanted package at a version inside its range. Returns how many links were added. */
export async function satisfyWanted(
  repo: LoadedRepo,
  links: DependencyLinks,
  wanted: Map<string, Wanted>,
  fetcher: PackageFetcher | undefined,
): Promise<number> {
  let added = 0;
  for (const [dep, { range, from }] of wanted) {
    if (links.decided.has(dep)) continue;
    links.decided.add(dep);
    const consumer = installedVersion(repo, dep);
    if (consumerCopySatisfies(from, dep, range, consumer?.version)) continue;
    // Protocol specifiers (workspace:, npm:, file:) are not ranges; only the consumer's copy can serve them.
    if (/^[a-z]+:/i.test(range)) continue;
    // An exact pin needs no version list; lockstep releases (the same-scope case) usually pin.
    const exact = EXACT.test(range.trim()) ? range.trim() : undefined;
    const versions = exact
      ? [exact]
      : fetcher?.versions
        ? await fetcher.versions(dep).catch(() => [])
        : [];
    const best = maxSatisfying(versions, range);
    if (best === undefined) {
      if (consumer) links.unsatisfied.push(`${dep}@${consumer.version} does not satisfy ${range}`);
      else if (!fetcher?.versions) links.unsatisfied.push(`${dep}@${range} not installed`);
      continue;
    }
    if (consumer && consumer.version === best) {
      links.links.set(dep, consumer.dir);
      links.linked.push(`${dep}@${best} (consumer)`);
      added++;
      continue;
    }
    try {
      const fetchedDir = await fetcher?.fetch(dep, best);
      if (!fetchedDir) continue;
      links.fetched.push(fetchedDir);
      links.links.set(dep, fetchedDir.dir);
      links.linked.push(`${dep}@${best} (fetched)`);
      added++;
    } catch (err) {
      links.unsatisfied.push(`${dep}@${best}: ${(err as Error).message}`);
    }
  }
  links.linked.sort();
  links.unsatisfied.sort();
  return added;
}
