import { satisfies } from '../fetch/range.js';
import type { Manifest } from './evidence.js';
import type { ListedDependency, ListGroup } from './list.js';

/** Conservative scope grouping: both ends have identical versions, or there is a peer edge.
 * A scope alone is not evidence (e.g. independently versioned @types packages). */
export function dependencyGroups(
  packages: ListedDependency[],
  metadata: Map<string, Manifest[]>,
  targets: Map<string, Manifest> = new Map(),
): ListGroup[] {
  const names = [...new Set(packages.map((p) => p.name))];
  const parent = new Map(names.map((name) => [name, name]));
  const find = (name: string): string => {
    let root = name;
    while (parent.get(root) !== root) root = parent.get(root) as string;
    return root;
  };
  const union = (a: string, b: string): void => {
    parent.set(find(a), find(b));
  };
  const lockstep = new Map<string, ListedDependency[]>();
  for (const p of packages) {
    if (p.name.startsWith('@') && !p.name.startsWith('@types/')) {
      const key = `${p.name.split('/')[0]}:${p.current}:${p.latest}`;
      const earlier = lockstep.get(key) ?? [];
      for (const other of earlier) {
        if (other.workspaces.some((w) => p.workspaces.includes(w))) union(p.name, other.name);
      }
      earlier.push(p);
      lockstep.set(key, earlier);
    }
    for (const m of [...(metadata.get(p.name) ?? []), targets.get(p.name) ?? {}]) {
      for (const [peer, range] of Object.entries(m.peerDependencies ?? {})) {
        if (!parent.has(peer) || range === '*' || !range.trim()) continue;
        if (
          packages.some(
            (other) =>
              other.name === peer &&
              other.workspaces.some((w) => p.workspaces.includes(w)) &&
              ((p.name.startsWith('@') && peer.startsWith(`${p.name.split('/')[0]}/`)) ||
                (m === targets.get(p.name) &&
                  !satisfies(other.current, range) &&
                  satisfies(other.latest, range))),
          )
        )
          union(p.name, peer);
      }
    }
  }
  const groups = new Map<string, ListedDependency[]>();
  for (const p of packages) {
    const key = find(p.name);
    const group = groups.get(key) ?? [];
    group.push(p);
    groups.set(key, group);
  }
  const result = [...groups.values()]
    .filter((members) => new Set(members.map((p) => p.name)).size > 1)
    .map((members) => {
      const scopeOf = (name: string): string | undefined =>
        name.startsWith('@') ? name.split('/')[0] : undefined;
      const peersOf = (name: string): string[] => [
        ...new Set(
          [...(metadata.get(name) ?? []), targets.get(name) ?? {}].flatMap((m) =>
            Object.keys(m.peerDependencies ?? {}),
          ),
        ),
      ];
      // Prefer the framework's source-used scope, then the package requiring the peers.
      const leaders = [...members].sort((a, b) => {
        const rank = (p: ListedDependency): number => {
          const scope = scopeOf(p.name);
          return (
            (scope
              ? members.filter((m) => scopeOf(m.name) === scope && m.classification === 'used')
                  .length * 100
              : 0) +
            peersOf(p.name).filter((peer) => members.some((m) => m.name === peer)).length * 10 +
            Number(p.classification === 'used')
          );
        };
        return rank(b) - rank(a) || a.name.localeCompare(b.name);
      });
      const lead = leaders[0] as ListedDependency;
      const scope = scopeOf(lead.name);
      for (const p of members) {
        if (p.name === lead.name || (scope && scopeOf(p.name) === scope)) continue;
        const peerOf = members
          .filter((m) => peersOf(m.name).includes(p.name))
          .map((m) => m.name)
          .sort();
        if (peerOf.length) {
          p.peerOf = peerOf;
          if (p.classification === 'possibly-unused' && lead.classification !== 'possibly-unused') {
            p.classification = 'peer';
            p.reasons = peerOf.map((name) => `peer of ${name}`);
          }
        }
      }
      members.sort(
        (a, b) =>
          Number(!!a.peerOf) - Number(!!b.peerOf) ||
          a.name.localeCompare(b.name) ||
          a.current.localeCompare(b.current),
      );
      const lockstepSize = Math.max(
        0,
        ...members
          .filter((p) => scopeOf(p.name) === scope)
          .map((p) => {
            const cohort = lockstep.get(`${scope}:${p.current}:${p.latest}`) ?? [];
            return new Set(
              cohort
                .filter((other) => other.workspaces.some((w) => p.workspaces.includes(w)))
                .map((other) => other.name),
            ).size;
          }),
      );
      return { lead: lead.name, scope, lockstepSize, members };
    });
  // A scope label belongs to its primary lockstep release set, not every scoped lead.
  // Independent tooling/peer groups keep their lead's full package name as the selector.
  const scopeSets = new Map<string, (typeof result)[number]>();
  for (const group of [...result].sort(
    (a, b) =>
      b.members.filter((p) => p.classification === 'used').length -
        a.members.filter((p) => p.classification === 'used').length ||
      b.lockstepSize - a.lockstepSize ||
      a.lead.localeCompare(b.lead),
  )) {
    if (group.scope && group.lockstepSize > 1 && !scopeSets.has(group.scope))
      scopeSets.set(group.scope, group);
  }
  const named = result.map((group) => {
    const scope = group.scope && scopeSets.get(group.scope) === group ? group.scope : undefined;
    return {
      id: scope ? scope.slice(1) : group.lead,
      lead: group.lead,
      name: scope ? `${scope}/*` : group.lead,
      members: group.members,
    };
  });
  // A real unscoped package may share the scope shorthand; retain both exact titles.
  for (const group of named) {
    if (
      named.some((other) => other !== group && other.id === group.id) &&
      group.name.endsWith('/*')
    )
      group.id = group.name;
  }
  return named;
}
