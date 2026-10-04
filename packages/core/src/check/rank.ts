import { compareVersions, majorsBehind } from './version.js';

export interface Candidate {
  name: string;
  installed: string;
  /** Undefined when the registry did not answer: the package is still tried, last. */
  latest?: string;
  /** Files of the repository that import the package: the cheap stand-in for call sites. */
  importSites: number;
}

/** Whether there is anything to analyze: the target is newer than what is installed. */
export function isBehind(c: Pick<Candidate, 'installed' | 'latest'>): boolean {
  return c.latest !== undefined && compareVersions(c.latest, c.installed) > 0;
}

/**
 * The order dependencies are analyzed in when time is limited: what is most likely to hurt
 * first. Major upgrades before minor and patch ones, then the packages the code imports in
 * the most places. Stable by name, so two runs rank alike.
 */
export function rankCandidates(candidates: Candidate[]): Candidate[] {
  const major = (c: Candidate): number => (c.latest ? majorsBehind(c.installed, c.latest) : 0);
  return [...candidates].sort(
    (a, b) =>
      Number(major(b) > 0) - Number(major(a) > 0) ||
      b.importSites - a.importSites ||
      Number(b.latest !== undefined) - Number(a.latest !== undefined) ||
      a.name.localeCompare(b.name),
  );
}
