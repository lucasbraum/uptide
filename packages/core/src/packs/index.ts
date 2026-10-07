import { type PackStatus, type RegisteredPack, recordedStatus } from './contract.js';
import { REGISTRY } from './registry.js';
import type { MigrationPack } from './types.js';

/** Every pack in this tree, candidates included: what `uptide pack test` scores. */
export function registeredPacks(): readonly RegisteredPack[] {
  return REGISTRY;
}

export function packStatus(entry: RegisteredPack): PackStatus {
  return recordedStatus(entry.verification);
}

/**
 * The packs `check`, `list` and `fix` use: verified ones only. A candidate ships in the tree
 * and `pack test` scores it, but until its ground truth meets the gate the dependency is
 * analyzed and migrated as generic.
 */
export function activePacks(): readonly MigrationPack[] {
  return REGISTRY.filter((e) => packStatus(e) === 'verified').map((e) => e.pack);
}

export function activePack(name: string): MigrationPack | undefined {
  return activePacks().find((p) => p.name === name);
}
