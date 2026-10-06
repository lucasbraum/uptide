import { satisfies } from '../fetch/range.js';
import type { Manifest } from './evidence.js';
import type { ListedDependency, ListGroup } from './list.js';

const scopeOf = (name: string): string | undefined =>
  name.startsWith('@') ? name.split('/')[0] : undefined;
/** `@types/*` packages are versioned independently of each other: a scope is no family there. */
const familyOf = (name: string): string | undefined => {
  const scope = scopeOf(name);
  return scope && scope !== '@types' ? scope : undefined;
};
const EXACT = /^\d+\.\d+\.\d+(?:-[\w.]+)?$/;
const inRange = (version: string, range: string): boolean => {
  try {
    return satisfies(version, range);
  } catch {
    return false;
  }
};

/** Why two outdated packages upgrade together. */
type Link = 'family' | 'peer link' | `shared ${string}`;

/**
 * Packages that upgrade together, and why:
 * - family: the same scope (`@radix-ui/*`), whatever versions its members are at;
 * - peer link: the latest version of one needs the other at its latest, through a peer
 *   range (`@nestjs/platform-fastify` and `@fastify/static`);
 * - shared pin: both pin the same exact version of a dependency, and their latest versions
 *   pin the same newer one (`ai` and `@ai-sdk/openai` on `@ai-sdk/provider`), so moving one
 *   alone leaves two copies of it.
 * Only packages sharing a workspace are linked: two apps may upgrade independently.
 */
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
  const edges: { a: string; b: string; link: Link }[] = [];
  const link = (a: string, b: string, kind: Link): void => {
    if (a === b) return;
    edges.push({ a, b, link: kind });
    parent.set(find(a), find(b));
  };
  const share = (a: ListedDependency, b: ListedDependency): boolean =>
    a.workspaces.some((w) => b.workspaces.includes(w));
  for (const [i, p] of packages.entries()) {
    for (const other of packages.slice(i + 1)) {
      const family = familyOf(p.name);
      if (family && family === familyOf(other.name) && share(p, other))
        link(p.name, other.name, 'family');
    }
    // Only a peer the latest version needs moved links two packages. An installed peer
    // range that holds another back is a blocking signal (peerBlocks), not a group: React's
    // whole ecosystem would otherwise fold into one group on its way to a new major.
    for (const [peer, range] of Object.entries(targets.get(p.name)?.peerDependencies ?? {})) {
      if (range === '*' || !range.trim()) continue;
      for (const other of packages)
        if (
          other.name === peer &&
          share(p, other) &&
          !inRange(other.current, range) &&
          inRange(other.latest, range)
        )
          link(p.name, other.name, 'peer link');
    }
  }
  // Shared pins: `dep@installed→target`, the same move made by two packages at once.
  const moves = new Map<string, { dep: string; movers: ListedDependency[] }>();
  for (const p of packages) {
    const target = targets.get(p.name)?.dependencies ?? {};
    for (const m of metadata.get(p.name) ?? [])
      for (const [dep, pinned] of Object.entries(m.dependencies ?? {})) {
        const next = target[dep];
        if (!EXACT.test(pinned) || !next || !EXACT.test(next) || next === pinned) continue;
        const key = JSON.stringify([dep, pinned, next]);
        const move = moves.get(key) ?? { dep, movers: [] };
        if (!move.movers.includes(p)) move.movers.push(p);
        moves.set(key, move);
      }
  }
  for (const { dep, movers } of moves.values())
    for (const [i, p] of movers.entries())
      for (const other of movers.slice(i + 1))
        if (share(p, other)) link(p.name, other.name, `shared ${dep}`);

  const components = new Map<string, ListedDependency[]>();
  for (const p of packages) {
    const key = find(p.name);
    components.set(key, [...(components.get(key) ?? []), p]);
  }
  const peersOf = (name: string): string[] => [
    ...new Set(
      [...(metadata.get(name) ?? []), targets.get(name) ?? {}].flatMap((m) =>
        Object.keys(m.peerDependencies ?? {}),
      ),
    ),
  ];
  const named: ListGroup[] = [...components.values()]
    .filter((members) => new Set(members.map((p) => p.name)).size > 1)
    .map((members) => {
      const inGroup = new Set(members.map((p) => p.name));
      const own = edges.filter((e) => inGroup.has(e.a) && inGroup.has(e.b));
      // The hub of the non-family links leads (`ai` among `@ai-sdk/*`), then the package
      // requiring the others as peers, then what is used.
      // Distinct neighbours outside its own family: `ai` links to three `@ai-sdk/*`
      // packages, each of them to `ai` alone (their links to each other are in-family).
      const degree = (name: string): number =>
        new Set(
          own
            .filter((e) => e.link !== 'family' && (e.a === name || e.b === name))
            .map((e) => (e.a === name ? e.b : e.a))
            .filter((n) => !familyOf(name) || familyOf(n) !== familyOf(name)),
        ).size;
      const peersInGroup = (name: string): number =>
        peersOf(name).filter((peer) => inGroup.has(peer)).length;
      const lead = [...members].sort(
        (a, b) =>
          degree(b.name) - degree(a.name) ||
          peersInGroup(b.name) - peersInGroup(a.name) ||
          Number(b.classification === 'used') - Number(a.classification === 'used') ||
          b.usage.files - a.usage.files ||
          Number(!!scopeOf(a.name)) - Number(!!scopeOf(b.name)) ||
          a.name.localeCompare(b.name),
      )[0] as ListedDependency;
      const families = [
        ...new Set(own.filter((e) => e.link === 'family').map((e) => familyOf(e.a) as string)),
      ].sort();
      // Links inside one family add nothing to its name; the ones reaching past it explain.
      const links = [
        ...new Set(
          own
            .filter(
              (e) => e.link !== 'family' && (!familyOf(e.a) || familyOf(e.a) !== familyOf(e.b)),
            )
            .map((e) => e.link),
        ),
      ];
      const leadFamily = familyOf(lead.name);
      const family = leadFamily && families.includes(leadFamily) ? leadFamily : undefined;
      for (const p of members) {
        if (p.name === lead.name || (familyOf(p.name) && familyOf(p.name) === familyOf(lead.name)))
          continue;
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
      const extraFamilies = families.filter((f) => f !== family);
      return {
        id: family && !extraFamilies.length ? family.slice(1) : lead.name,
        lead: lead.name,
        name: [family ? `${family}/*` : lead.name, ...extraFamilies.map((f) => `${f}/*`)].join(
          ' + ',
        ),
        reason:
          [...(family ? [`${family} family`] : []), ...links.slice(0, 2)].join(', ') || 'family',
        members,
      };
    });
  // Two families in separate workspaces, or a real package named like a scope shorthand,
  // keep distinct selectors: a family's full name when that is unique, else each lead.
  const byId = new Map<string, ListGroup[]>();
  for (const group of named) byId.set(group.id, [...(byId.get(group.id) ?? []), group]);
  for (const clash of byId.values()) {
    if (clash.length < 2) continue;
    for (const group of clash)
      group.id =
        group.name !== group.lead && clash.filter((o) => o.name === group.name).length === 1
          ? group.name
          : (group.lead as string);
  }
  return named;
}

/**
 * Outdated packages whose installed peer range holds another outdated package back:
 * `{ '@ai-sdk/react': ['react 19'] }` when its peer range stops short of react's latest.
 */
export function peerBlocks(
  packages: ListedDependency[],
  metadata: Map<string, Manifest[]>,
): Map<string, string[]> {
  const blocks = new Map<string, string[]>();
  for (const p of packages)
    for (const m of metadata.get(p.name) ?? [])
      for (const [peer, range] of Object.entries(m.peerDependencies ?? {})) {
        const other = packages.find(
          (o) => o.name === peer && o.workspaces.some((w) => p.workspaces.includes(w)),
        );
        if (!other || range === '*' || !inRange(other.current, range)) continue;
        if (inRange(other.latest, range)) continue;
        const label = `${other.name} ${other.latest.split('.')[0]}`;
        const list = blocks.get(p.name) ?? [];
        if (!list.includes(label)) blocks.set(p.name, [...list, label]);
      }
  return blocks;
}
