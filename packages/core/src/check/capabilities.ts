import type { LanguageAdapter, RepoDir } from '../domain/adapter.js';
import type { ApiSurface } from '../domain/surface.js';
import type { FindUsagesResult } from '../domain/usage.js';
import { AdapterCapabilityError } from '../errors.js';

/** The `findUsages` of an adapter, or a typed error. `check` never substitutes an empty list. */
export function requireFindUsages(
  adapter: LanguageAdapter,
): (repo: RepoDir, pkg: string, surface: ApiSurface) => Promise<FindUsagesResult> {
  const find = adapter.findUsages;
  if (!find) throw new AdapterCapabilityError(adapter.id, 'findUsages');
  return find.bind(adapter);
}
