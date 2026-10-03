import { homedir } from 'node:os';
import { join } from 'node:path';

export function defaultCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.UPTIDE_CACHE_DIR) return env.UPTIDE_CACHE_DIR;
  const base = env.XDG_CACHE_HOME || join(homedir(), '.cache');
  return join(base, 'uptide');
}

/** `@scope/name` becomes two nested directories; anything else is used as-is. */
export function packagePathSegments(name: string): string[] {
  return name.split('/');
}
