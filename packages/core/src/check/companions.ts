import { satisfies } from '../fetch/range.js';
import type { Manifest } from '../list/evidence.js';
import { dependencyGroups } from '../list/groups.js';
import type { ListedDependency } from '../list/list.js';
import { compareVersions, parseVersion } from './version.js';

/**
 * The packages that have to move with one upgrade. `ai` and the `@ai-sdk/*` packages a
 * repository installs pin the same `@ai-sdk/provider`: `ai` 7 next to `@ai-sdk/react` 3 is
 * an install no lockfile of the upgrade has, with two copies of the provider's types. The
 * group is the one `list` shows (`dependencyGroups`: family, peer link, shared pin); the
 * version each companion moves to is the one that agrees with the target:
 * - the version the target pins exactly (`ai@7.0.9` → `@ai-sdk/provider` 4.0.1);
 * - else the installed one, when its range for the target already accepts it
 *   (`@modelcontextprotocol/sdk` 1.28.0 takes `zod` `^3.25 || ^4.0`: nothing to move);
 * - else its newest release that pins the target exactly, or whose range for it accepts
 *   the target (`@ai-sdk/react@4.0.10` → `ai` 7.0.9);
 * - else its newest release whose exact pins agree with every exact pin of the target
 *   (`@ai-sdk/openai` on `@ai-sdk/provider`).
 */
export interface Companion {
  name: string;
  from: string;
  to: string;
  /** Why this version: `ai 7.0.9 pins @ai-sdk/provider 4.0.1`. */
  reason: string;
}

export interface InstalledDependency {
  name: string;
  version: string;
  /** The installed copy's manifest: what it depends on and pins today. */
  manifest: Manifest;
  workspaces: string[];
}

export interface CompanionPlan {
  companions: Companion[];
  /** Members of the group with no release that agrees: the upgrade cannot be consistent. */
  conflicts: string[];
  /** The group as `list` names it (`@ai-sdk family, shared @ai-sdk/provider-utils`). */
  reason?: string;
}

type Manifests = Record<string, Pick<Manifest, 'dependencies' | 'peerDependencies'>>;

const EXACT = /^\d+\.\d+\.\d+(?:-[\w.]+)?$/;
const scopeOf = (name: string): string | undefined =>
  name.startsWith('@') && !name.startsWith('@types/') ? name.split('/')[0] : undefined;
const stable = (version: string): boolean => {
  const parsed = parseVersion(version);
  return parsed !== undefined && parsed.pre === undefined;
};
const accepts = (range: string, version: string): boolean => {
  try {
    return satisfies(version, range);
  } catch {
    return false;
  }
};
const exactPins = (m: Pick<Manifest, 'dependencies'>): Map<string, string> =>
  new Map(Object.entries(m.dependencies ?? {}).filter(([, v]) => EXACT.test(v)));

/** Whether `other` is plausibly in `lead`'s group, from what is installed: worth asking the registry about. */
function related(lead: InstalledDependency, other: InstalledDependency): boolean {
  if (!lead.workspaces.some((w) => other.workspaces.includes(w))) return false;
  const mentions = (m: Manifest, name: string) =>
    name in (m.dependencies ?? {}) || name in (m.peerDependencies ?? {});
  if (mentions(lead.manifest, other.name) || mentions(other.manifest, lead.name)) return true;
  const theirs = exactPins(other.manifest);
  for (const [dep, version] of exactPins(lead.manifest))
    if (theirs.get(dep) === version) return true;
  return false;
}

/** The release of `name` that agrees with `lead@target`, and why; undefined when none does. */
function agreeing(
  installed: InstalledDependency,
  lead: string,
  target: string,
  targetManifest: Pick<Manifest, 'dependencies'>,
  versions: Manifests,
): { version: string; reason: string } | undefined {
  const name = installed.name;
  const pinned = targetManifest.dependencies?.[name];
  if (pinned && EXACT.test(pinned) && versions[pinned])
    return { version: pinned, reason: `${lead} ${target} pins ${name} ${pinned}` };
  const current = versions[installed.version] ?? installed.manifest;
  const range = current.dependencies?.[lead] ?? current.peerDependencies?.[lead];
  if (range !== undefined && accepts(range, target))
    return {
      version: installed.version,
      reason: `${name} ${installed.version} accepts ${lead} ${target}`,
    };
  const candidates = Object.keys(versions).filter(stable).sort(compareVersions).reverse();
  for (const version of candidates) {
    const m = versions[version] ?? {};
    const range = m.dependencies?.[lead] ?? m.peerDependencies?.[lead];
    if (range === undefined || !accepts(range, target)) continue;
    return {
      version,
      reason: EXACT.test(range)
        ? `${name} ${version} pins ${lead} ${target}`
        : `${name} ${version} accepts ${lead} ${target} (${range})`,
    };
  }
  const leadPins = exactPins(targetManifest);
  for (const version of candidates) {
    const pins = exactPins(versions[version] ?? {});
    const shared = [...pins].filter(([dep]) => leadPins.has(dep));
    if (shared.length > 0 && shared.every(([dep, v]) => leadPins.get(dep) === v))
      return {
        version,
        reason: `${name} ${version} pins ${shared.map(([dep, v]) => `${dep} ${v}`).join(', ')}, as ${lead} ${target} does`,
      };
  }
  return undefined;
}

/**
 * What moves with `name@target` in a repository, from its installed dependencies and the
 * registry's manifests of every version (`manifests`, one cached packument per package).
 */
export async function companionsOf(input: {
  name: string;
  target: string;
  installed: InstalledDependency[];
  manifests: (name: string) => Promise<Manifests>;
}): Promise<CompanionPlan> {
  const lead = input.installed.find((d) => d.name === input.name);
  if (!lead) return { companions: [], conflicts: [] };
  const targetManifest = (await input.manifests(input.name))[input.target];
  if (!targetManifest) return { companions: [], conflicts: [] };
  // Plausible members: related to the lead, then the rest of their families.
  const direct = input.installed.filter((d) => d.name !== lead.name && related(lead, d));
  const families = new Set(direct.map((d) => scopeOf(d.name)).filter(Boolean));
  const scope = scopeOf(lead.name);
  if (scope) families.add(scope);
  const candidates = input.installed.filter(
    (d) =>
      d.name !== lead.name &&
      (direct.includes(d) ||
        (families.has(scopeOf(d.name)) && d.workspaces.some((w) => lead.workspaces.includes(w)))),
  );
  if (candidates.length === 0) return { companions: [], conflicts: [] };

  const moves = new Map<string, { version: string; reason: string } | undefined>();
  for (const c of candidates)
    moves.set(
      c.name,
      agreeing(c, lead.name, input.target, targetManifest, await input.manifests(c.name)),
    );

  // The group, as `list` draws it, with each member at the version that agrees.
  const listed = (d: InstalledDependency, latest: string): ListedDependency =>
    ({
      name: d.name,
      current: d.version,
      latest,
      workspaces: d.workspaces,
      classification: 'used',
      reasons: [],
      // The package being upgraded leads the group, as the one `list` shows used most.
      usage: { files: d === lead ? 1 : 0, callSites: 0, references: 0, workspaces: d.workspaces },
    }) as unknown as ListedDependency;
  const packages = [
    listed(lead, input.target),
    ...candidates.map((c) => listed(c, moves.get(c.name)?.version ?? c.version)),
  ];
  const metadata = new Map(input.installed.map((d) => [d.name, [d.manifest]]));
  const targets = new Map<string, Manifest>([[lead.name, targetManifest]]);
  for (const c of candidates) {
    const move = moves.get(c.name);
    const manifest = move && (await input.manifests(c.name))[move.version];
    if (manifest) targets.set(c.name, manifest);
  }
  const group = dependencyGroups(packages, metadata, targets).find((g) =>
    g.members.some((m) => m.name === lead.name),
  );
  if (!group) return { companions: [], conflicts: [] };
  const companions: Companion[] = [];
  const conflicts: string[] = [];
  for (const member of group.members) {
    if (member.name === lead.name) continue;
    const move = moves.get(member.name);
    if (!move) {
      conflicts.push(
        `${member.name} ${member.current} has no release that agrees with ${lead.name} ${input.target}`,
      );
      continue;
    }
    if (move.version === member.current) continue;
    companions.push({
      name: member.name,
      from: member.current,
      to: move.version,
      reason: move.reason,
    });
  }
  return {
    companions: companions.sort((a, b) => a.name.localeCompare(b.name)),
    conflicts,
    ...(group.reason ? { reason: group.reason } : {}),
  };
}
