import type { Change } from '../domain/change.js';
import { parentOf } from '../domain/path.js';

export interface Folded {
  /** Changes worth a human's attention, in the original order. */
  shown: Change[];
  hidden: {
    /** Member changes whose ancestor was itself removed or moved. */
    impliedByRemoval: Change[];
    /** The same change seen under an alias path. */
    aliasDuplicates: Change[];
    /** `protected` or `@internal` symbols. */
    nonPublic: Change[];
  };
}

/**
 * Pure. Full `Change[]` is the contract (milestone 2 needs every path); this is the view
 * for humans: fold what a reader would consider one change into one line.
 */
export function foldForDisplay(changes: Change[]): Folded {
  // A removed or moved container takes its members with it.
  const removedPaths = new Set(
    changes.filter((c) => c.kind === 'removed' || c.kind === 'moved').map((c) => c.path),
  );
  const keys = new Set(changes.map((c) => `${c.kind}:${c.path}`));
  const implied = (c: Change): boolean => {
    let p = parentOf(c.path);
    while (p !== undefined) {
      if (removedPaths.has(p)) return true;
      p = parentOf(p);
    }
    return false;
  };
  const folded: Folded = {
    shown: [],
    hidden: { impliedByRemoval: [], aliasDuplicates: [], nonPublic: [] },
  };
  for (const c of changes) {
    if (c.visibility !== undefined) folded.hidden.nonPublic.push(c);
    else if (implied(c)) folded.hidden.impliedByRemoval.push(c);
    else if (c.aliasOf !== undefined && keys.has(`${c.kind}:${c.aliasOf}`))
      folded.hidden.aliasDuplicates.push(c);
    else folded.shown.push(c);
  }
  return folded;
}

export function depthOf(path: string): number {
  return (path.match(/[.#]|\[\]/g) ?? []).length;
}
