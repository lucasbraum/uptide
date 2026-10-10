import { satisfies } from '../fetch/range.js';
import type { Manifest } from '../list/evidence.js';
import { dependencyGroups } from '../list/groups.js';
import type { ListedDependency } from '../list/list.js';
import { typedPackageOf, typesReleaseFor } from './types-release.js';
import { compareVersions, parseVersion } from './version.js';

/** Packages that must move with an upgrade: exact dependency pins, release pairs and runtime types. */
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
  /**
   * Packages left where they are though their installed peer range rejects the target:
   * `next-mdx-remote-client 1.1.2 declares react >= 18.3.0 < 19.0.0`. Possible impact, never breaking.
   */
  peerConflicts: string[];
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

/** Lowest stable compatible peer release, never below the installed version. */
export function compatiblePeerVersion(
  versions: Manifests,
  installed: string,
  targets: Record<string, string>,
  required: readonly string[] = Object.keys(targets),
): string | undefined {
  return Object.keys(versions)
    .filter((v) => stable(v) && compareVersions(v, installed) >= 0)
    .sort(compareVersions)
    .find((v) => {
      const ranges = versions[v]?.peerDependencies ?? {};
      return (
        required.every((name) => ranges[name] !== undefined) &&
        Object.entries(targets).every(
          ([name, target]) => ranges[name] === undefined || accepts(ranges[name], target),
        )
      );
    });
}

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

/** Whether `name` is released with `lead@target`: it has a release at the target's own version that asks for it. */
function releasedWith(lead: string, target: string, versions: Manifests): boolean {
  const same = versions[target];
  const range = same?.dependencies?.[lead] ?? same?.peerDependencies?.[lead];
  return same !== undefined && range !== undefined && accepts(range, target);
}

/**
 * `<pkg> <installed> declares <peer> <range>` when the package only peers on `host`, its
 * installed range rejects the target, and nothing says it moves with it (named by the pack, or
 * released at the target's own version). Undefined: it is a companion, or it agrees already.
 */
export function peerConflictOf(
  installed: InstalledDependency,
  host: string,
  target: string,
  versions: Manifests,
  lockstep: readonly string[] = [],
): string | undefined {
  if (lockstep.includes(installed.name) || releasedWith(host, target, versions)) return undefined;
  const current = installed.manifest;
  // A dependency (an exact pin) is moved by the pin logic; only a bare peer is left alone.
  if (current.dependencies?.[host] !== undefined) return undefined;
  const range = current.peerDependencies?.[host];
  if (range === undefined || accepts(range, target)) return undefined;
  return `${installed.name} ${installed.version} declares ${host} ${range}`;
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
  const current = installed.manifest;
  const range = current.dependencies?.[lead] ?? current.peerDependencies?.[lead];
  if (range !== undefined && accepts(range, target))
    return {
      version: installed.version,
      reason: `${name} ${installed.version} accepts ${lead} ${target}`,
    };
  const pinned = targetManifest.dependencies?.[name];
  if (pinned && EXACT.test(pinned) && versions[pinned])
    return compareVersions(pinned, installed.version) >= 0
      ? { version: pinned, reason: `${lead} ${target} pins ${name} ${pinned}` }
      : undefined;
  // Actual release pairs (react/react-dom) must still use matching runtime versions.
  const same = versions[target];
  const sameRange = same?.dependencies?.[lead] ?? same?.peerDependencies?.[lead];
  if (
    same &&
    sameRange !== undefined &&
    accepts(sameRange, target) &&
    compareVersions(target, installed.version) >= 0
  )
    return {
      version: target,
      reason: `${name} ${target} is released with ${lead} ${target} (${EXACT.test(sameRange) ? 'pins' : 'peer'} ${sameRange})`,
    };
  if (
    current.peerDependencies?.[lead] !== undefined &&
    current.dependencies?.[lead] === undefined
  ) {
    const version = compatiblePeerVersion(versions, installed.version, { [lead]: target });
    return version === undefined
      ? undefined
      : {
          version,
          reason: `${name} ${version} accepts ${lead} ${target} (${versions[version]?.peerDependencies?.[lead]})`,
        };
  }
  const candidates = Object.keys(versions)
    .filter((v) => stable(v) && compareVersions(v, installed.version) >= 0)
    .sort(compareVersions);
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

/** Whether a workspace of `dep` serves a workspace of `host`: the same one, or an ancestor (the root hoists for all). */
function visibleFrom(dep: InstalledDependency, host: InstalledDependency): boolean {
  return dep.workspaces.some((d) =>
    host.workspaces.some((h) => h === d || d === '.' || h.startsWith(`${d}/`)),
  );
}

/** `@types/<pkg>` for a `<pkg>` of the plan: the only link a types package has to its runtime. */
function typesOf(dep: InstalledDependency, host: InstalledDependency): boolean {
  return typedPackageOf(dep.name) === host.name && visibleFrom(dep, host);
}

/** The `@types` release that types `host@hostTarget`, when it is not the installed one. */
function typesMove(
  dep: InstalledDependency,
  host: string,
  hostTarget: string,
  versions: Manifests,
): { version: string; reason: string } | undefined {
  const version = typesReleaseFor(Object.keys(versions), hostTarget, dep.version);
  if (version === undefined) return undefined;
  return { version, reason: `${dep.name} ${version} types ${host} ${hostTarget}` };
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
  /** Known companions eligible to move when their installed peer range rejects the target. */
  lockstep?: readonly string[];
  /** Targets already planned before an explicitly requested peer upgrade. */
  peerTargets?: Record<string, string>;
}): Promise<CompanionPlan> {
  const none: CompanionPlan = { companions: [], conflicts: [], peerConflicts: [] };
  const lead = input.installed.find((d) => d.name === input.name);
  if (!lead) return none;
  const targetManifest = (await input.manifests(input.name))[input.target];
  if (!targetManifest) return none;
  // Plausible members: related to the lead, the rest of their families, and the types
  // packages of any of those; then what relates to a member the same way, until nothing new.
  const scope = scopeOf(lead.name);
  const members: InstalledDependency[] = [lead];
  const families = new Set<string>();
  if (scope) families.add(scope);
  const grow = (): boolean => {
    let grew = false;
    for (const d of input.installed) {
      if (members.includes(d) || d.name === lead.name) continue;
      const host = members.find((m) => related(m, d) || typesOf(d, m));
      const scope = scopeOf(d.name);
      const family =
        scope !== undefined &&
        families.has(scope) &&
        d.workspaces.some((w) => lead.workspaces.includes(w));
      if (!host && !family) continue;
      members.push(d);
      if (host && scope !== undefined) families.add(scope);
      grew = true;
    }
    return grew;
  };
  while (grow()) {
    // until the closure is complete
  }
  const candidates = members.filter((d) => d !== lead);
  if (candidates.length === 0) return none;

  // Each candidate moves to the version that agrees with a decided package: the lead, else a
  // companion already placed (`@types/react-dom` with `react-dom`, which moved with `react`).
  const decided = new Map<string, { version: string; manifest: Manifests[string] }>([
    [lead.name, { version: input.target, manifest: targetManifest }],
  ]);
  const moves = new Map<string, { version: string; reason: string } | undefined>();
  const typesLinked = new Set<string>();
  /** Peer-linked packages left in place, by name. */
  const peerConflicts = new Map<string, string>();
  const names = new Set(members.map((m) => m.name));
  // A types package waits for the package it types (`@types/react-dom` for `react-dom`), which
  // may be placed in a later pass; only when that never happens does its own manifest decide.
  for (let progress = true, waitForTyped = true; progress || waitForTyped; ) {
    if (!progress) waitForTyped = false;
    progress = false;
    for (const c of candidates) {
      if (moves.get(c.name) !== undefined) continue;
      const typed = typedPackageOf(c.name);
      const typesHost =
        typed !== undefined && decided.has(typed)
          ? input.installed.find((d) => d.name === typed && typesOf(c, d))
          : undefined;
      if (!typesHost && typed !== undefined && names.has(typed) && waitForTyped) continue;
      const versions = await input.manifests(c.name);
      let move: { version: string; reason: string } | undefined;
      if (typesHost) {
        move = typesMove(
          c,
          typed as string,
          decided.get(typed as string)?.version as string,
          versions,
        );
        if (move) typesLinked.add(c.name);
      } else {
        // A shared pin cannot move a peer that already supports the planned runtime, or
        // silently upgrade a blocker that the user has not added to the command.
        const peers = Object.entries({ ...input.peerTargets, [lead.name]: input.target }).filter(
          ([host]) =>
            c.manifest.peerDependencies?.[host] !== undefined &&
            c.manifest.dependencies?.[host] === undefined,
        );
        if (peers.length) {
          const rejected = peers.filter(
            ([host, target]) => !accepts(c.manifest.peerDependencies?.[host] as string, target),
          );
          if (!rejected.length) {
            move = {
              version: c.version,
              reason: `${c.name} ${c.version} accepts the planned peers`,
            };
          } else if (
            rejected.some(
              ([host, target]) =>
                peerConflictOf(c, host, target, versions, input.lockstep) !== undefined,
            )
          ) {
            peerConflicts.set(
              c.name,
              rejected
                .map(([host, target]) => peerConflictOf(c, host, target, versions, input.lockstep))
                .filter(Boolean)
                .join('; '),
            );
            continue;
          }
        }
        for (const [host, at] of move ? [] : decided) {
          const hostDep = input.installed.find((d) => d.name === host);
          if (!hostDep || !related(hostDep, c)) continue;
          const left = peerConflictOf(c, host, at.version, versions, input.lockstep);
          if (left) {
            peerConflicts.set(c.name, left);
            continue;
          }
          move = agreeing(c, host, at.version, at.manifest, versions);
          if (move) {
            peerConflicts.delete(c.name);
            break;
          }
        }
      }
      moves.set(c.name, move);
      if (move) {
        decided.set(c.name, { version: move.version, manifest: versions[move.version] ?? {} });
        progress = true;
      }
    }
  }

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
  const inGroup = new Set((group?.members ?? [listed(lead, input.target)]).map((m) => m.name));
  // A package the pack names is a member whatever `list` draws: the pack knows it moves with the lead.
  for (const c of candidates)
    if (input.lockstep?.includes(c.name) && moves.get(c.name) !== undefined) inGroup.add(c.name);
  // `list` links nothing to a types package: `@types/<pkg>` joins the group of its `<pkg>`,
  // and what `list` would group with it (`@types/react-dom`, a peer of `@types/react`) follows.
  for (let grew = true; grew; ) {
    grew = false;
    for (const c of candidates) {
      if (inGroup.has(c.name) || moves.get(c.name) === undefined) continue;
      const typed = typedPackageOf(c.name);
      const joins =
        (typesLinked.has(c.name) && typed !== undefined && inGroup.has(typed)) ||
        dependencyGroups(packages, metadata, targets).some(
          (g) =>
            g.members.some((m) => m.name === c.name) && g.members.some((m) => inGroup.has(m.name)),
        );
      if (!joins) continue;
      inGroup.add(c.name);
      grew = true;
    }
  }
  if (inGroup.size < 2) return none;
  const companions: Companion[] = [];
  const conflicts: string[] = [];
  for (const member of candidates.filter((c) => inGroup.has(c.name))) {
    const move = moves.get(member.name);
    // Left in place on purpose: reported as a peer conflict, not as an upgrade that cannot agree.
    if (!move && peerConflicts.has(member.name)) continue;
    if (!move) {
      conflicts.push(
        `${member.name} ${member.version} has no release that agrees with ${lead.name} ${input.target}`,
      );
      continue;
    }
    if (move.version === member.version) continue;
    companions.push({
      name: member.name,
      from: member.version,
      to: move.version,
      reason: move.reason,
    });
  }
  const typed = [
    ...new Set(
      companions.filter((c) => typesLinked.has(c.name)).map((c) => typedPackageOf(c.name)),
    ),
  ];
  const reason = [group?.reason, typed.length ? `types for ${typed.join(', ')}` : undefined]
    .filter(Boolean)
    .join(', ');
  return {
    companions: companions.sort((a, b) => a.name.localeCompare(b.name)),
    conflicts,
    peerConflicts: [...peerConflicts.values()].sort(),
    ...(reason ? { reason } : {}),
  };
}
