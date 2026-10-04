import { isFailure } from '../check/check.js';
import { compareVersions } from '../check/version.js';
import type { CheckReport, PackageReport, PlanGroup, Tier } from '../domain/report.js';
import { satisfies } from '../fetch/range.js';

/** What the upgrade is expected to cost, read off the findings. An estimate, not a promise. */
export interface Effort {
  /**
   * `none`: nothing in the code is affected. `small`: rules do it, or a handful of sites
   * for the agent. `medium`: up to 25 sites that need the agent or a person. `large`: more.
   */
  level: 'unknown' | 'none' | 'small' | 'medium' | 'large';
  /** Breaking sites, by who migrates them. */
  byRule: number;
  byAgent: number;
  manual: number;
  /** Sites the declarations changed under and nothing confirmed: to look at, not to fix. */
  unconfirmed: number;
}

/** One peer range that the upgrade order has to respect. */
export interface PeerConstraint {
  /** The package that declares the peer range. */
  from: string;
  /** Its version the range was read from: the target, or what is installed. */
  fromVersion: string;
  /** The package the range is about. */
  on: string;
  range: string;
  /**
   * `before`: `on` has to be upgraded first. `together`: both in one step. `blocked`: no
   * version in this plan satisfies the range.
   */
  effect: 'before' | 'together' | 'blocked';
  /** One sentence for the reader. */
  reason: string;
}

export interface PlannedPackage {
  name: string;
  installed: string;
  target: string;
  tier: Tier;
  effort: Effort;
}

export interface UpgradeStep {
  /** 1-based position in the plan. */
  order: number;
  /** One package, or several that have to (or may as well) move in the same change. */
  packages: PlannedPackage[];
  /** Why several packages share the step: nothing to migrate, or a peer range ties them. */
  together?: 'no-impact' | 'peer';
  /** The step's effort: the largest of its packages'. */
  effort: Effort['level'];
  /** The peer ranges that put this step where it is. */
  constraints: PeerConstraint[];
}

export interface UpgradePlan {
  notes?: string[];
  steps: UpgradeStep[];
  /** Behind and not in the plan: not analyzed, with the reason. */
  notPlanned: { name: string; installed: string; reason: string }[];
}

/** Peer ranges by package name; undefined when the manifest could not be read. */
export type Peers = Record<string, string> | undefined;

export interface PeerLookup {
  /** `peerDependencies` of `name` at the version the plan upgrades it to. */
  ofTarget(name: string, version: string): Peers;
  /** `peerDependencies` of a direct dependency as installed, and its version. */
  installed: Record<string, { version: string; peers: Record<string, string> }>;
}

const sitesOf = (groups: PlanGroup[], pick: (g: PlanGroup) => number): number =>
  groups.reduce((n, g) => n + pick(g), 0);

/** The effort a package's findings imply. Deprecations cost nothing now and are not counted. */
export function effortOf(
  p: Pick<PackageReport, 'plan'> & Partial<Pick<PackageReport, 'status' | 'importers'>>,
): Effort {
  const breaking = (p.plan ?? []).filter((g) => g.severity === 'breaking');
  const unverified = (p.plan ?? []).filter((g) => g.severity === 'unverified');
  const byRule = sitesOf(breaking, (g) => g.by.rule);
  const byAgent = sitesOf(breaking, (g) => g.by.agent);
  const manual = sitesOf(breaking, (g) => g.by.manual);
  const unconfirmed = sitesOf(unverified, (g) => g.sites);
  const hands = byAgent + manual;
  const level: Effort['level'] =
    p.status === 'unknown' || p.status === 'partial' || p.importers?.some((i) => !i.analyzed)
      ? 'unknown'
      : hands > 25
        ? 'large'
        : hands > 5
          ? 'medium'
          : hands > 0 || byRule > 0 || unconfirmed > 0
            ? 'small'
            : 'none';
  return { level, byRule, byAgent, manual, unconfirmed };
}

const RANK: Record<Effort['level'], number> = {
  none: 0,
  small: 1,
  medium: 2,
  large: 3,
  unknown: 4,
};

/** Whether `version` is inside `range`; a range npm cannot parse constrains nothing. */
function within(version: string, range: string): boolean {
  try {
    return satisfies(version, range);
  } catch {
    return true;
  }
}

/**
 * The order to upgrade in. Peer ranges decide what has to come first or move together;
 * within that, what costs nothing comes first (one step, bumped together), then the rest
 * from the smallest effort to the largest, so each step lands on a tree that already
 * compiles. Pure: the report and the peer ranges in, the plan out.
 */
export function planUpgrades(report: CheckReport, peers: PeerLookup): UpgradePlan {
  const behind = report.packages.filter(
    (p) =>
      !p.notes.includes('up to date') &&
      !['not-imported', 'workspace', 'private'].includes(p.status) &&
      p.installed !== p.target,
  );
  const analyzed = behind.filter((p) => p.status !== 'skipped' && p.status !== 'no-types');
  const notPlanned = behind
    .filter((p) => !analyzed.includes(p))
    .map((p) => ({
      name: p.name,
      installed: p.installed,
      reason:
        p.skipReason === 'TIME_BUDGET'
          ? 'not analyzed: out of time'
          : isFailure(p)
            ? `not analyzed: ${(p.notes[0] ?? 'analysis failed').split('\n')[0]}`
            : (p.notes[0] ?? 'not analyzed'),
    }));
  // A release group is planned as its members' names; everything else as itself.
  const planned = new Map<string, PlannedPackage>();
  for (const p of analyzed) {
    const effort = effortOf(p);
    for (const m of p.members ?? [p]) {
      const previous = planned.get(m.name);
      planned.set(m.name, {
        name: m.name,
        installed:
          previous && compareVersions(previous.installed, m.installed) < 0
            ? previous.installed
            : m.installed,
        target: m.target,
        tier: p.tier ?? 'generic',
        effort:
          previous && RANK[previous.effort.level] > RANK[effort.level] ? previous.effort : effort,
      });
    }
  }
  const constraints: PeerConstraint[] = [];
  const before = new Map<string, Set<string>>(); // name -> names that must come first
  const tied = new Map<string, string>(); // union-find parent
  const find = (name: string): string => {
    const parent = tied.get(name) ?? name;
    if (parent === name) return name;
    const root = find(parent);
    tied.set(name, root);
    return root;
  };
  const tie = (a: string, b: string): void => {
    tied.set(find(a), find(b));
  };
  for (const a of planned.values()) {
    // What the target of A asks of its peers.
    for (const [on, range] of Object.entries(peers.ofTarget(a.name, a.target) ?? {})) {
      const installed = planned.get(on)?.installed ?? peers.installed[on]?.version;
      if (installed === undefined || within(installed, range)) continue;
      const b = planned.get(on);
      if (b && within(b.target, range)) {
        // Does B's target still accept A as installed? If not, neither can go first.
        const back = peers.ofTarget(b.name, b.target)?.[a.name];
        const together = back !== undefined && !within(a.installed, back);
        constraints.push({
          from: a.name,
          fromVersion: a.target,
          on,
          range,
          effect: together ? 'together' : 'before',
          reason: together
            ? `${a.name} ${a.target} needs ${on} ${range}, and ${on} ${b.target} needs ${a.name} ${back}: upgrade them together`
            : `${a.name} ${a.target} needs ${on} ${range} (installed: ${installed}): upgrade ${on} first`,
        });
        if (together) tie(a.name, on);
        else before.set(a.name, new Set([...(before.get(a.name) ?? []), on]));
      } else
        constraints.push({
          from: a.name,
          fromVersion: a.target,
          on,
          range,
          effect: 'blocked',
          reason: `${a.name} ${a.target} needs ${on} ${range}; ${on} is at ${installed}${b ? ` and its target ${b.target} is outside that range too` : ' and is not being upgraded'}`,
        });
    }
    // What the rest of the repository, as installed, asks of A.
    for (const [x, { version, peers: asked }] of Object.entries(peers.installed)) {
      const range = asked[a.name];
      if (range === undefined || x === a.name || within(a.target, range)) continue;
      const upgraded = planned.get(x);
      const next = upgraded ? peers.ofTarget(x, upgraded.target)?.[a.name] : undefined;
      if (upgraded && (next === undefined || within(a.target, next))) {
        // X's target accepts the new A. If it also accepts the old one, X simply goes first.
        const together = next !== undefined && !within(a.installed, next);
        constraints.push({
          from: x,
          fromVersion: version,
          on: a.name,
          range,
          effect: together ? 'together' : 'before',
          reason: together
            ? `${x} ${version} needs ${a.name} ${range} and ${x} ${upgraded.target} needs ${a.name} ${next}: upgrade them together`
            : `${x} ${version} needs ${a.name} ${range}: upgrade ${x} to ${upgraded.target} first, which accepts ${a.name} ${a.target}`,
        });
        if (together) tie(a.name, x);
        else before.set(a.name, new Set([...(before.get(a.name) ?? []), x]));
      } else
        constraints.push({
          from: x,
          fromVersion: version,
          on: a.name,
          range,
          effect: 'blocked',
          reason: `${x} ${version} needs ${a.name} ${range}, and ${a.name} ${a.target} is outside it${upgraded ? ` (so is what ${x} ${upgraded.target} accepts)` : `; ${x} has no upgrade in this plan`}`,
        });
    }
  }
  // Groups: packages a peer range ties, plus the release groups check already formed.
  for (const p of analyzed)
    for (const m of p.members ?? []) tie(m.name, (p.members ?? [])[0]?.name ?? m.name);
  const groups = new Map<string, PlannedPackage[]>();
  for (const p of planned.values())
    groups.set(find(p.name), [...(groups.get(find(p.name)) ?? []), p]);
  const levelOf = (members: PlannedPackage[]): Effort['level'] =>
    members.map((m) => m.effort.level).sort((a, b) => RANK[b] - RANK[a])[0] ?? 'none';
  const waitsOn = (root: string): Set<string> =>
    new Set(
      (groups.get(root) ?? [])
        .flatMap((m) => [...(before.get(m.name) ?? [])])
        .map(find)
        .filter((other) => other !== root),
    );
  const constraintsOf = (members: PlannedPackage[]): PeerConstraint[] => {
    const names = new Set(members.map((m) => m.name));
    return constraints.filter((c) => names.has(c.from) || names.has(c.on));
  };
  // Free, unconstrained, no-impact packages share the first step.
  const free = [...groups].filter(
    ([root, members]) =>
      levelOf(members) === 'none' &&
      waitsOn(root).size === 0 &&
      constraintsOf(members).length === 0,
  );
  const steps: Omit<UpgradeStep, 'order'>[] = [];
  const done = new Set<string>();
  if (free.length > 0) {
    steps.push({
      packages: free.flatMap(([, members]) => members).sort((a, b) => a.name.localeCompare(b.name)),
      ...(free.flatMap(([, m]) => m).length > 1 ? { together: 'no-impact' as const } : {}),
      effort: 'none',
      constraints: [],
    });
    for (const [root] of free) done.add(root);
  }
  // The rest: smallest effort first, never before what it waits on.
  const rest = [...groups].filter(([root]) => !done.has(root));
  while (rest.length > 0) {
    const ready = rest
      .filter(([root]) => [...waitsOn(root)].every((other) => done.has(other)))
      .sort(
        ([, a], [, b]) =>
          RANK[levelOf(a)] - RANK[levelOf(b)] || (a[0]?.name ?? '').localeCompare(b[0]?.name ?? ''),
      );
    // A cycle the ties did not catch: take what is left in a stable order rather than loop.
    const [root, members] = (ready[0] ?? rest[0]) as [string, PlannedPackage[]];
    steps.push({
      packages: [...members].sort((a, b) => a.name.localeCompare(b.name)),
      ...(members.length > 1 ? { together: 'peer' as const } : {}),
      effort: levelOf(members),
      constraints: constraintsOf(members),
    });
    done.add(root);
    rest.splice(
      rest.findIndex(([r]) => r === root),
      1,
    );
  }
  return { steps: steps.map((step, i) => ({ order: i + 1, ...step })), notPlanned };
}
