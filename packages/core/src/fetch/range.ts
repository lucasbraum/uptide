import semver from 'semver';

/** npm's complete range grammar, with its default prerelease exclusion rules. */
export function satisfies(version: string, range: string): boolean {
  return semver.satisfies(version, range);
}

export function maxSatisfying(versions: readonly string[], range: string): string | undefined {
  return semver.maxSatisfying([...versions], range) ?? undefined;
}
