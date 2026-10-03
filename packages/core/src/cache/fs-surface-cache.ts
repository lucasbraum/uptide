import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { SurfaceCache, SurfaceCacheKey } from '../domain/io.js';
import type { ApiSurface } from '../domain/surface.js';
import { defaultCacheDir, packagePathSegments } from './paths.js';

export function surfaceCachePath(root: string, key: SurfaceCacheKey): string {
  return join(
    root,
    'surfaces',
    key.adapter,
    `v${key.schema}`,
    ...packagePathSegments(key.package),
    `${key.version}.json`,
  );
}

export function createFsSurfaceCache(opts: { dir?: string } = {}): SurfaceCache {
  const root = opts.dir ?? defaultCacheDir();
  return {
    async get(key) {
      try {
        return JSON.parse(await readFile(surfaceCachePath(root, key), 'utf8')) as ApiSurface;
      } catch {
        return undefined;
      }
    },
    async set(key, surface) {
      const path = surfaceCachePath(root, key);
      await mkdir(dirname(path), { recursive: true });
      // Write-then-rename so a crash never leaves a half-written surface behind.
      // Worker threads share a pid: two workspaces caching the same surface need distinct files.
      const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(tmp, JSON.stringify(surface));
      await rename(tmp, path);
    },
  };
}
