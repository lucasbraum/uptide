import { compareVersions, parseVersion } from '../check/version.js';
import { satisfies } from '../fetch/range.js';

/**
 * What makes an outdated dependency worth upgrading first. Every rule is deterministic
 * and reads only what discovery already has (registry metadata, the usage scan) plus one
 * bulk advisory request. Weights and examples: docs/priorities.md.
 */

/** Urgency, highest first; a package is ranked by its most urgent signal. */
export const URGENCY = {
  security: 5,
  deprecated: 4,
  unsupported: 3,
  blocking: 2,
  behind: 1,
} as const;
export type Signal = keyof typeof URGENCY;

const SEVERITIES = ['critical', 'high', 'moderate', 'low'] as const;
export type Severity = (typeof SEVERITIES)[number];

/** One entry of the npm bulk advisory response. */
export interface Advisory {
  severity: string;
  title: string;
  url: string;
  vulnerable_versions: string;
}

export interface PackageSignals {
  security?: {
    advisories: number;
    worst: Severity;
    counts: Partial<Record<Severity, number>>;
    /** The smallest fix: the lowest stable version above the installed one that none of its advisories covers. */
    fixedIn?: string;
    /** What moving to `fixedIn` is: within the installed major (patch, minor) or a new major. */
    fixChange?: 'patch' | 'minor' | 'major';
  };
  /** The registry's deprecation message for the installed version. */
  deprecated?: string;
  /** The installed major line has had no release since this month (`YYYY-MM`) while a newer major exists. */
  unsupported?: { since: string };
  /** Outdated packages this one's installed peer range holds back (`react 19`). */
  blocks?: string[];
  /** Outdated packages it must move with (a peer link or a shared pin). */
  movesWith?: string[];
  /** Majors between installed and latest. */
  behind: number;
  /** Cost to upgrade; lower is cheaper. See `effortOf`. */
  effort: number;
  /** Only in devDependencies, or tooling: ranked after runtime packages (see urgencyOf). */
  dev?: boolean;
}

const inRange = (version: string, range: string): boolean => {
  try {
    return satisfies(version, range);
  } catch {
    return false;
  }
};
const stable = (v: string): boolean => {
  const parsed = parseVersion(v);
  return !!parsed && !parsed.pre;
};

/** Advisories affecting the installed version, their worst severity and the first fixed version. */
export function securitySignal(
  current: string,
  advisories: Advisory[],
  versions: string[],
): PackageSignals['security'] {
  const hits = advisories.filter((a) => inRange(current, a.vulnerable_versions));
  if (!hits.length) return undefined;
  const severity = (a: Advisory): Severity =>
    (SEVERITIES as readonly string[]).includes(a.severity) ? (a.severity as Severity) : 'low';
  const counts: Partial<Record<Severity, number>> = {};
  for (const a of hits) counts[severity(a)] = (counts[severity(a)] ?? 0) + 1;
  const fixedIn = versions
    .filter(
      (v) =>
        stable(v) &&
        compareVersions(v, current) > 0 &&
        !hits.some((a) => inRange(v, a.vulnerable_versions)),
    )
    .sort(compareVersions)[0];
  const from = parseVersion(current);
  const to = fixedIn ? parseVersion(fixedIn) : undefined;
  const fixChange =
    from && to
      ? to.major !== from.major
        ? 'major'
        : to.minor !== from.minor
          ? 'minor'
          : 'patch'
      : undefined;
  return {
    advisories: hits.length,
    worst: SEVERITIES.find((s) => counts[s]) as Severity,
    counts,
    ...(fixedIn ? { fixedIn } : {}),
    ...(fixChange ? { fixChange } : {}),
  };
}

/** A deprecation message, when the registry marks the installed version deprecated. */
export function deprecatedSignal(message: string | undefined): string | undefined {
  const text = message?.replace(/\s+/g, ' ').trim();
  return text || undefined;
}

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
/**
 * The installed major line is unsupported when a newer major exists and the line's last
 * release is a year old or more. `published` is the registry's `time` map.
 */
export function unsupportedSignal(
  current: string,
  latest: string,
  published: Record<string, string>,
  now: Date,
): PackageSignals['unsupported'] {
  const major = parseVersion(current)?.major;
  if (major === undefined || (parseVersion(latest)?.major ?? major) <= major) return undefined;
  const last = Object.entries(published)
    .filter(([v]) => stable(v) && parseVersion(v)?.major === major)
    .map(([, when]) => Date.parse(when))
    .filter((t) => !Number.isNaN(t))
    .sort((a, b) => b - a)[0];
  if (last === undefined || now.getTime() - last < YEAR_MS) return undefined;
  return { since: new Date(last).toISOString().slice(0, 7) };
}

/**
 * Upgrade cost from the usage scan: a file to touch costs 1, ten call sites cost 1 more,
 * and a verified migration pack halves it (its rules do the work and its checks catch the
 * rest). Tooling and possibly-unused packages have no files and cost nearly nothing.
 */
export function effortOf(usage: { files: number; callSites: number }, verified: boolean): number {
  const raw = usage.files + usage.callSites / 10;
  return Math.round((verified ? raw / 2 : raw) * 10) / 10;
}

/**
 * The most urgent signal, and its rank. Security also orders by severity (critical +0.4,
 * high +0.3, moderate +0.2, low +0.1), and a dev-only package drops one severity step: a
 * critical advisory in a test runner ranks with a high one in production code, and the
 * runtime package wins that tie (rankPriorities).
 */
export function urgencyOf(s: PackageSignals): { signal: Signal; urgency: number } | undefined {
  if (s.security)
    return {
      signal: 'security',
      urgency:
        Math.round(
          (URGENCY.security +
            (SEVERITIES.length - SEVERITIES.indexOf(s.security.worst)) / 10 -
            (s.dev ? 0.1 : 0)) *
            10,
        ) / 10,
    };
  if (s.deprecated) return { signal: 'deprecated', urgency: URGENCY.deprecated };
  if (s.unsupported) return { signal: 'unsupported', urgency: URGENCY.unsupported };
  if (s.blocks?.length || s.movesWith?.length)
    return { signal: 'blocking', urgency: URGENCY.blocking };
  // One major behind is the normal state of an outdated package; two is a signal of its own.
  if (s.behind >= 2) return { signal: 'behind', urgency: URGENCY.behind };
  return undefined;
}

const files = (n: number): string => `${n} file${n === 1 ? '' : 's'} to touch`;
const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;

/** One line saying why: the most urgent signal, in words; `dev · ` first for a dev-only package. */
export function reasonOf(s: PackageSignals, current: string, usageFiles: number): string {
  const text = signalText(s, current, usageFiles);
  return text && s.dev ? `dev · ${text}` : text;
}
/** `fixed in 3.2.5 (patch, same major)`, `needs 4.1.11 (major)`. */
function fixText(sec: NonNullable<PackageSignals['security']>): string {
  if (!sec.fixedIn) return 'no fixed version yet';
  return sec.fixChange === 'major'
    ? `needs ${sec.fixedIn} (major)`
    : `fixed in ${sec.fixedIn} (${sec.fixChange}, same major)`;
}
function signalText(s: PackageSignals, current: string, usageFiles: number): string {
  const top = urgencyOf(s)?.signal;
  const touch = usageFiles ? `, ${files(usageFiles)}` : '';
  switch (top) {
    case 'security': {
      const sec = s.security as NonNullable<PackageSignals['security']>;
      const n = sec.advisories;
      return `${n} ${n === 1 ? 'advisory' : 'advisories'} (${sec.counts[sec.worst]} ${sec.worst}), ${fixText(sec)}`;
    }
    case 'deprecated':
      return `deprecated: ${truncate(s.deprecated as string, 60)}`;
    case 'unsupported':
      return `${parseVersion(current)?.major}.x line unsupported since ${s.unsupported?.since}${touch}`;
    case 'blocking':
      return s.blocks?.length
        ? `blocks ${s.blocks.join(', ')}`
        : `moves with ${(s.movesWith ?? []).join(', ')}`;
    case 'behind':
      return `${s.behind} majors behind${touch}`;
    default:
      return '';
  }
}

export interface Priority {
  /** What the row names: a package, or a group's name. */
  name: string;
  /** The group id, when the row is a group (`uptide check --group <id>`). */
  group?: string;
  /** The packages the row upgrades. */
  packages: string[];
  signal: Signal;
  urgency: number;
  effort: number;
  reason: string;
  /** Dev-only: ranked after a runtime row of the same urgency. */
  dev?: boolean;
  /** Its advisories are fixed within the installed major: ranked before a major-only fix. */
  sameMajorFix?: boolean;
  /** `name@version` to check: the smallest fix, when there is one. */
  target?: string;
}

/** Ties, in order: runtime before dev, a same-major fix before a major-only one, then cheaper. */
const tieBreak = (
  a: { dev?: boolean; sameMajorFix?: boolean; effort: number },
  b: { dev?: boolean; sameMajorFix?: boolean; effort: number },
): number =>
  Number(!!a.dev) - Number(!!b.dev) ||
  Number(!!b.sameMajorFix) - Number(!!a.sameMajorFix) ||
  a.effort - b.effort;

/** Most urgent first; among equals, runtime, then a same-major fix, then the cheaper upgrade. */
export function rankPriorities(items: Priority[]): Priority[] {
  return [...items].sort(
    (a, b) => b.urgency - a.urgency || tieBreak(a, b) || a.name.localeCompare(b.name),
  );
}

/** The ranking fields a package's signals give its row. */
function rowOf(
  p: Upgradable,
  s: PackageSignals,
): Pick<Priority, 'dev' | 'sameMajorFix' | 'target'> {
  const fix = urgencyOf(s)?.signal === 'security' ? s.security : undefined;
  return {
    ...(s.dev ? { dev: true } : {}),
    ...(fix?.fixChange && fix.fixChange !== 'major' ? { sameMajorFix: true } : {}),
    ...(fix?.fixedIn ? { target: `${p.name}@${fix.fixedIn}` } : {}),
  };
}

/** A minor or patch release touching at most this many files is cheap. */
export const CHEAP_FILES = 3;

interface Upgradable {
  name: string;
  current: string;
  change: 'major' | 'minor' | 'patch';
  classification: string;
  usage: { files: number };
  signals?: PackageSignals;
}

/**
 * The priority rows: a group is one row (ranked by its most urgent member, costed as the
 * sum of its members), any other package its own. Then the cheap batch: minor and patch
 * upgrades with no urgent signal, touching at most CHEAP_FILES files, outside those rows.
 */
export function prioritize(
  packages: Upgradable[],
  groups: { id: string; name: string; lead?: string; reason?: string; members: Upgradable[] }[],
): { priorities: Priority[]; cheapBatch: string[] } {
  const rows: Priority[] = [];
  const grouped = new Set<Upgradable>();
  const top = (members: Upgradable[]) =>
    members
      .map((p) => ({ p, u: p.signals ? urgencyOf(p.signals) : undefined }))
      .filter((x): x is { p: Upgradable; u: NonNullable<ReturnType<typeof urgencyOf>> } => !!x.u)
      // The member that says most: most urgent, runtime, same-major fix, furthest behind, cheapest.
      .sort((a, b) => {
        const sa = a.p.signals as PackageSignals;
        const sb = b.p.signals as PackageSignals;
        return (
          b.u.urgency - a.u.urgency ||
          Number(!!sa.dev) - Number(!!sb.dev) ||
          Number(!!rowOf(b.p, sb).sameMajorFix) - Number(!!rowOf(a.p, sa).sameMajorFix) ||
          sb.behind - sa.behind ||
          sa.effort - sb.effort
        );
      })[0];
  for (const g of groups) {
    for (const p of g.members) grouped.add(p);
    // Moving with, or holding back, the rest of its own group is what the group already
    // says; only an urgent signal beyond that makes the group a priority.
    const inGroup = new Set(g.members.map((p) => p.name));
    const members = g.members.map((p) => {
      if (!p.signals) return p;
      const blocks = p.signals.blocks?.filter((b) => !inGroup.has(b.slice(0, b.lastIndexOf(' '))));
      return {
        ...p,
        signals: {
          ...p.signals,
          movesWith: undefined,
          blocks: blocks?.length ? blocks : undefined,
        },
      };
    });
    const best = top(members);
    if (!best) continue;
    const reason = reasonOf(best.p.signals as PackageSignals, best.p.current, best.p.usage.files);
    rows.push({
      name: g.name,
      group: g.id,
      packages: [...new Set(g.members.map((p) => p.name))],
      signal: best.u.signal,
      urgency: best.u.urgency,
      effort: g.members.reduce((n, p) => n + (p.signals?.effort ?? 0), 0),
      // A member other than the lead is named before its reason, after any `dev · `.
      reason:
        best.p.name === (g.lead ?? g.name)
          ? reason
          : reason.startsWith('dev · ')
            ? `dev · ${best.p.name} ${reason.slice('dev · '.length)}`
            : `${best.p.name} ${reason}`,
      ...rowOf(best.p, best.p.signals as PackageSignals),
    });
  }
  for (const p of packages) {
    if (grouped.has(p) || !p.signals) continue;
    const u = urgencyOf(p.signals);
    if (!u) continue;
    rows.push({
      name: p.name,
      packages: [p.name],
      signal: u.signal,
      urgency: u.urgency,
      effort: p.signals.effort,
      reason: reasonOf(p.signals, p.current, p.usage.files),
      ...rowOf(p, p.signals),
    });
  }
  const priorities = rankPriorities(rows);
  const urgent = new Set(priorities.flatMap((r) => r.packages));
  const cheap = (p: Upgradable): boolean =>
    p.change !== 'major' &&
    !urgent.has(p.name) &&
    p.classification !== 'possibly-unused' &&
    p.usage.files <= CHEAP_FILES &&
    !(p.signals && urgencyOf(p.signals));
  // A group upgrades together: its members join the batch only when all of them are cheap.
  const groupOf = new Map(groups.flatMap((g) => g.members.map((p) => [p, g] as const)));
  const cheapBatch = [
    ...new Set(
      packages
        .filter((p) => cheap(p) && (groupOf.get(p)?.members.every(cheap) ?? true))
        .sort((a, b) => (a.signals?.effort ?? 0) - (b.signals?.effort ?? 0))
        .map((p) => p.name),
    ),
  ];
  return { priorities, cheapBatch };
}
