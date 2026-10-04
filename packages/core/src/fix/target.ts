import { createNpmFetcher } from '../fetch/npm-fetcher.js';
import type { MigrationPack } from '../packs/types.js';

export interface ResolvedTarget {
  version: string;
  /** Where the version came from, for the reader: `latest on npm`, `requested`, the pack's tested target. */
  source: 'requested' | 'latest on npm' | "the pack's tested target";
}

/**
 * One answer to "which version" for check and fix alike: what was asked for, else the npm
 * `latest` dist-tag, which is what check compares against. The pack's tested target is only
 * the fallback for a run that cannot reach the registry.
 */
export async function resolveTarget(
  pack: Pick<MigrationPack, 'name' | 'defaultTarget'>,
  requested: string | undefined,
  resolve: (name: string, tag: string) => Promise<string> = (name, tag) =>
    createNpmFetcher().resolve(name, tag),
): Promise<ResolvedTarget> {
  if (requested) {
    const version = requested.replace(new RegExp(`^${pack.name}@`), '');
    if (version !== 'latest') return { version, source: 'requested' };
  }
  try {
    return { version: await resolve(pack.name, 'latest'), source: 'latest on npm' };
  } catch (err) {
    // Without a pack there is no tested target to fall back on: the registry has to answer.
    if (!pack.defaultTarget) throw err;
    return { version: pack.defaultTarget, source: "the pack's tested target" };
  }
}
