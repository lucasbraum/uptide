import { parseVersion } from './version.js';

/**
 * Packages that version in lockstep are upgraded together: `@aws-sdk/client-s3` alone at
 * 3.1141.0 next to `@aws-sdk/core` at 3.1076.0 is a state no install ever produces, and
 * the errors it compiles to are nobody's. A release group is a set of dependencies of one
 * scope connected by depending or peer-depending on one another (`@bull-board/express` 5 on
 * `@bull-board/api` 6: an explicit edge groups across majors, the two move together
 * whatever the drift), or installed on the same major and depending on the same package of
 * that scope (`@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` share
 * `@aws-sdk/core`; the shared package need not be a direct dependency itself). Singletons
 * are not groups.
 */
export interface GroupCandidate {
  name: string;
  installed: string;
  /** Names this package depends or peer-depends on (from its installed manifest). */
  dependsOn: string[];
}

export function releaseGroups(candidates: GroupCandidate[]): string[][] {
  const byName = new Map(candidates.map((c) => [c.name, c]));
  const keyOf = (c: GroupCandidate): string | undefined => {
    if (!c.name.startsWith('@')) return undefined;
    const major = parseVersion(c.installed)?.major;
    return major === undefined ? undefined : `${c.name.split('/')[0]}@${major}`;
  };
  // Union-find over edges between candidates of the same scope and major.
  const parent = new Map<string, string>();
  const find = (n: string): string => {
    let root = n;
    while (parent.get(root) !== root) root = parent.get(root) as string;
    return root;
  };
  for (const c of candidates) parent.set(c.name, c.name);
  // First candidate seen depending on a same-scope package, per scope+major key.
  const viaShared = new Map<string, string>();
  for (const c of candidates) {
    const key = keyOf(c);
    if (key === undefined) continue;
    const scope = c.name.split('/')[0] as string;
    for (const dep of c.dependsOn) {
      const other = byName.get(dep);
      if (other) {
        if (other.name.startsWith(`${scope}/`)) parent.set(find(c.name), find(other.name));
        continue;
      }
      if (!dep.startsWith(`${scope}/`)) continue;
      const sharedKey = `${key}:${dep}`;
      const earlier = viaShared.get(sharedKey);
      if (earlier) parent.set(find(c.name), find(earlier));
      else viaShared.set(sharedKey, c.name);
    }
  }
  const groups = new Map<string, string[]>();
  for (const c of candidates) {
    const root = find(c.name);
    const list = groups.get(root) ?? [];
    list.push(c.name);
    groups.set(root, list);
  }
  return [...groups.values()].filter((g) => g.length > 1).map((g) => g.sort());
}

/** `@aws-sdk/*` for a group; the name itself for a singleton. */
export function groupName(members: string[]): string {
  const first = members[0] as string;
  return members.length > 1 ? `${first.split('/')[0]}/*` : first;
}
