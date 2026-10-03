/** Enough semver to order releases and count majors; no ranges, no dependency. */
export function parseVersion(
  v: string,
): { major: number; minor: number; patch: number; pre: string | undefined } | undefined {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(v.trim());
  if (!m) return undefined;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] };
}

/** Negative when a < b, zero when equal, positive when a > b. A prerelease sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return a.localeCompare(b);
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (pa[key] !== pb[key]) return pa[key] - pb[key];
  }
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === undefined) return 1;
  if (pb.pre === undefined) return -1;
  return pa.pre.localeCompare(pb.pre);
}

export function majorsBehind(installed: string, target: string): number {
  const a = parseVersion(installed);
  const b = parseVersion(target);
  if (!a || !b) return 0;
  return Math.max(0, b.major - a.major);
}
