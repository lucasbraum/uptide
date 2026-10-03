import type { PackageDir } from './adapter.js';
import type { ApiSurface } from './surface.js';

/**
 * The only network boundary in milestone 1. Implementations download and extract a
 * published tarball; they never run install or lifecycle scripts.
 */
export interface PackageFetcher {
  fetch(name: string, version: string): Promise<PackageDir>;
  /** An exact version for a version or dist-tag (`latest`). */
  resolve(name: string, requested: string): Promise<string>;
  /** Every published version, oldest first. Optional: without it ranges cannot be satisfied from the registry. */
  versions?(name: string): Promise<string[]>;
  /**
   * Done with a fetched directory. A fetcher that extracts into a persistent cache keeps it;
   * without this method the caller removes the directory itself.
   */
  release?(pkg: PackageDir): Promise<void>;
}

export interface SurfaceCacheKey {
  package: string;
  version: string;
  adapter: string;
  schema: number;
}

/** Filesystem today; a remote service later, without touching the engine. */
export interface SurfaceCache {
  get(key: SurfaceCacheKey): Promise<ApiSurface | undefined>;
  set(key: SurfaceCacheKey, surface: ApiSurface): Promise<void>;
}
