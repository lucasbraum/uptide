declare module 'semver' {
  const semver: {
    satisfies(version: string, range: string): boolean;
    maxSatisfying(versions: string[], range: string): string | null;
    minVersion(range: string): { version: string } | null;
    validRange(range: string): string | null;
  };
  export default semver;
}
