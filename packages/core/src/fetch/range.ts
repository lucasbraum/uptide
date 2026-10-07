import semver from 'semver';

/** npm's complete range grammar, with its default prerelease exclusion rules. */
export function satisfies(version: string, range: string): boolean {
  return semver.satisfies(version, range);
}

export function maxSatisfying(versions: readonly string[], range: string): string | undefined {
  return semver.maxSatisfying([...versions], range) ?? undefined;
}

/** The lowest version a range admits (`>=4 <5` → `4.0.0`), or undefined for no valid range. */
export function minVersion(range: string): string | undefined {
  return semver.validRange(range) ? (semver.minVersion(range)?.version ?? undefined) : undefined;
}

/** Whether `range` is a semver range at all (`npm:`, `workspace:` and URLs are not). */
export function validRange(range: string): boolean {
  return semver.validRange(range) !== null;
}
