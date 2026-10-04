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
  return [...groups.values()]
    .filter((members) => new Set(members.map((p) => p.name)).size > 1)
    .map((members) => {
      members.sort((a, b) => a.name.localeCompare(b.name) || a.current.localeCompare(b.current));
      const scope = members[0]?.name.startsWith('@') ? members[0].name.split('/')[0] : undefined;
      return {
        name:
          scope && members.every((p) => p.name.startsWith(`${scope}/`))
            ? `${scope}/*`
            : [...new Set(members.map((p) => p.name))].join(' + '),
        members,
      };
    });
}
