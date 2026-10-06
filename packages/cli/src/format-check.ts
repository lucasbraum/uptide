import { basename } from 'node:path';
import {
  BY,
  type CheckReport,
  isFailure,
  type PackageReport,
  type PlanGroup,
  planPackage,
  TIER_LEGEND,
  verdictOf,
} from '@uptide/core';
import pc from 'picocolors';
import { formatCheckDetails } from './format-check-details.js';
import { importerNotes } from './importers.js';
import { alignedRows, terminalHeader } from './terminal.js';

/** What the first line says about the run: `uptide check · shop (pnpm, 6 packages) · 25s`. */
export interface CheckHeader {
  repo: string;
  manager: string;
  /** Workspace packages besides the root; 0 for a single-package repository. */
  packages: number;
  ms: number;
}

export interface FormatCheckOptions {
  color?: boolean;
  width?: number;
  /** Every site, reason, raw compiler message and note instead of one line per rule. */
  details?: boolean;
  /** With `details`: findings under 50% confidence too. */
  all?: boolean;
  header?: CheckHeader;
  /** How this build is invoked from a shell: `npx uptide@next`. */
  invocation?: string;
  /** Flags to repeat in the suggested commands so they act on the same repository and scope. */
  repeat?: { cwd?: string; only?: string; targets?: Record<string, string> };
  /**
   * Packages `fix` can migrate in this repository: every one when the package manager is
   * supported (`true`), none, or a list.
   */
  fixable?: readonly string[] | boolean;
  /** The time budget the run had, in seconds, to say how to raise it. */
  maxTime?: number;
}

/** Rows with no impact beyond this many are folded into one line: the first screen stays one screen. */
const NO_IMPACT_ROWS = 5;
/** Rule lines per package on the first screen; beyond that, a count. */
const MAX_RULE_LINES = 8;
/** Fix commands suggested at most; the rest is `uptide plan`'s job. */
const FIX_SUGGESTIONS = 3;

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** `shop (pnpm, 6 packages)`: the repository as the header and the start line name it. */
export function repoLine(h: Omit<CheckHeader, 'ms'>): string {
  const shape = h.packages > 0 ? `${h.manager}, ${plural(h.packages, 'package')}` : h.manager;
  return `${h.repo} (${shape})`;
}

type Colors = ReturnType<typeof pc.createColors>;

/** The plan the engine attached, or one computed here without a pack (everything manual). */
const planOf = (p: PackageReport): PlanGroup[] => p.plan ?? planPackage(p);

/** `--target` when the version was asked for, `latest on npm` when it is the registry's dist-tag. */
function targetSource(p: PackageReport, opts: FormatCheckOptions): string {
  if (opts.repeat?.targets?.[p.name] !== undefined) return '--target';
  return p.target === p.latest ? 'latest on npm' : '';
}

/** `major`, `minor` or `patch`: the first version part that moves. */
function bump(installed: string, target: string): string {
  const parts = (v: string): number[] => (v.match(/\d+/g) ?? []).slice(0, 3).map(Number);
  const [a, b] = [parts(installed), parts(target)];
  if (a.length < 3 || b.length < 3) return '';
  return a[0] !== b[0]
    ? (b[0] ?? 0) - (a[0] ?? 0) > 1
      ? `major ×${(b[0] ?? 0) - (a[0] ?? 0)}`
      : 'major'
    : a[1] !== b[1]
      ? 'minor'
      : a[2] !== b[2]
        ? 'patch'
        : '';
}

/** `21 auto-fixable · 4 need the agent (LLM)`: who migrates the sites. */
export function byLine(groups: PlanGroup[]): string {
  const total = { rule: 0, agent: 0, manual: 0 };
  for (const g of groups) {
    total.rule += g.by.rule;
    total.agent += g.by.agent;
    total.manual += g.by.manual;
  }
  return [
    total.rule > 0 ? BY.rule(total.rule) : '',
    total.agent > 0 ? BY.agent(total.agent) : '',
    total.manual > 0 ? `${total.manual} manual` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

const byLabel = (g: PlanGroup): string =>
  [
    g.by.rule > 0 ? BY.ruleTag : '',
    g.by.agent > 0 ? BY.agentTag : '',
    g.by.manual > 0 ? 'manual' : '',
  ]
    .filter(Boolean)
    .join(' + ');

const filesOf = (groups: PlanGroup[]): number =>
  new Set(groups.flatMap((g) => g.locations.map((l) => l.file))).size;
const sitesOf = (groups: PlanGroup[]): number => groups.reduce((n, g) => n + g.sites, 0);

export interface Row {
  p: PackageReport;
  name: string;
  versions: string;
  bump: string;
  verdict: string;
  by: string;
  plan: PlanGroup[];
  /** Nothing to act on: no breaking, unverified or deprecated site shown. */
  quiet: boolean;
  /** `0 breaking · compiled against 4.6.5: 0 new type errors`, for an analyzed package. */
  summary?: string;
}

const ANALYZED = ['breaking', 'deprecated', 'safe', 'partial', 'unknown'];
/** The package's verdict line; reports stored before it was kept get one derived. */
export const verdictLine = (p: PackageReport): string | undefined =>
  p.verdict?.summary ?? (ANALYZED.includes(p.status) ? verdictOf(p).summary : undefined);

/** Packages with nothing to decide (never imported, linked, private, up to date) have no row. */
function rowOf(p: PackageReport, multi: boolean, colors: Colors): Row | undefined {
  if (['not-imported', 'workspace', 'private'].includes(p.status)) return undefined;
  if (p.notes.includes('up to date')) return undefined;
  // A release group whose members are all current: nothing to upgrade, nothing to say.
  if (p.installed === p.target && p.findings.length === 0 && p.status === 'safe') return undefined;
  // Out of time or failed: listed once, under "Not analyzed", with how to include them.
  if (p.skipReason === 'TIME_BUDGET' || isFailure(p)) return undefined;
  // Without a pack, what nothing confirmed is for --details: the first screen acts on evidence.
  const generic = p.tier === 'generic';
  const plan = planOf(p).filter((g) => !(generic && g.severity === 'unverified'));
  const unconfirmed = generic ? sitesOf(planOf(p).filter((g) => g.severity === 'unverified')) : 0;
  const aside = unconfirmed > 0 ? colors.dim(` · ${unconfirmed} unconfirmed in --details`) : '';
  const of = (severity: PlanGroup['severity']): PlanGroup[] =>
    plan.filter((g) => g.severity === severity);
  const [breaking, unverified, deprecated] = [of('breaking'), of('unverified'), of('deprecated')];
  const where =
    multi && p.workspace !== '*' && p.workspace !== '.' ? colors.dim(` (${p.workspace})`) : '';
  const members = p.members ? ` (${plural(p.members.length, 'package')})` : '';
  const unanalyzed = p.unanalyzed.length;
  const gaps = (p.importers ?? []).filter((i) => !i.analyzed).length;
  let verdict: string;
  let by = '';
  if (p.status === 'no-types' || p.status === 'skipped') {
    const reason =
      p.notes.find((n) => n.startsWith('types in ')) ??
      p.notes.find((n) => /type declarations|not installed/.test(n)) ??
      p.notes[0] ??
      'no type declarations';
    verdict = colors.dim(`– not analyzed: ${reason.split(';')[0]}`);
  } else if (breaking.length > 0) {
    const sites = sitesOf(breaking);
    const files = filesOf(breaking);
    const extra = unverified.length > 0 ? `, ${sitesOf(unverified)} unverified` : '';
    verdict = `${colors.red('✗')} ${sites} breaking${sites > 1 ? ` in ${plural(files, 'file')}` : ''}${extra}${aside}`;
    by = byLine([...breaking, ...unverified]);
  } else if (unverified.length > 0) {
    verdict = `${colors.magenta('?')} ${sitesOf(unverified)} unverified`;
    by = byLine(unverified);
  } else if (deprecated.length > 0) {
    verdict = `${colors.yellow('!')} ${sitesOf(deprecated)} deprecated${aside}`;
    by = byLine(deprecated);
  } else if (p.status === 'unknown') {
    verdict = `${colors.magenta('?')} ${unanalyzed} of ${plural(p.callSitesChecked + unanalyzed, 'site')} not analyzed`;
  } else if (unanalyzed > 0) {
    verdict = `${colors.green('✓')} no impact in ${plural(p.callSitesChecked, 'site')}, ${unanalyzed} not analyzed${aside}`;
  } else if (gaps > 0) {
    // A workspace that imports it was not analyzed: "no impact" would claim more than is known.
    verdict = `${colors.magenta('?')} no impact in ${plural(p.callSitesChecked, 'site')}, ${plural(gaps, 'workspace')} not analyzed${aside}`;
  } else if (unconfirmed > 0) {
    verdict = `${colors.green('✓')} nothing confirmed ${colors.dim(`(${plural(p.callSitesChecked, 'call site')})`)}${aside}`;
  } else {
    verdict = `${colors.green('✓')} no impact ${colors.dim(`(${plural(p.callSitesChecked, 'call site')})`)}`;
  }
  return {
    p,
    name: `${p.name}${members}${where}`,
    versions: `${p.installed} → ${p.target}`,
    bump: bump(p.installed, p.target),
    verdict,
    by,
    plan,
    quiet:
      plan.length === 0 && gaps === 0 && !['no-types', 'skipped', 'unknown'].includes(p.status),
    ...(verdictLine(p) ? { summary: verdictLine(p) } : {}),
  };
}

/** Color codes start with the escape character and take no column. */
const COLOR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

/** `.email, .uuid, .datetime, ...`: the three most used deprecated names. */
function deprecatedNames(groups: PlanGroup[]): string {
  const counts = new Map<string, number>();
  for (const g of groups)
    for (const [name, n] of Object.entries(g.symbols ?? {}))
      counts.set(name, (counts.get(name) ?? 0) + n);
  const names = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return `${names
    .slice(0, 3)
    .map(([name]) => name)
    .join(', ')}${names.length > 3 ? ', ...' : ''}`;
}

/** One line per rule; deprecations are one line for the package. */
function sectionLines(row: Row, colors: Colors): string[] {
  const acting = row.plan.filter((g) => g.severity !== 'deprecated');
  const deprecated = row.plan.filter((g) => g.severity === 'deprecated');
  const importers = importerNotes(row.p);
  // A peer the target asks for and the repository does not have at that version: the usual
  // root cause of what follows, and the first thing to fix.
  const peers = row.p.notes.flatMap((note) => {
    const m = /: (\S+)@(\S+) is outside the peer range (.+?) of (\S+);/.exec(note);
    return m
      ? [
          `${m[4]} ${row.p.target} needs ${m[1]} ${m[3]} (installed: ${m[2]}): upgrade ${m[1]} first`,
        ]
      : [];
  });
  // Every analyzed package says its verdict and what verified it, zero breaking included.
  const heading = row.summary
    ? `${colors.bold(row.p.name)}   ${colors.dim(row.summary)}`
    : colors.bold(row.p.name);
  if (
    acting.length === 0 &&
    deprecated.length === 0 &&
    importers.length === 0 &&
    peers.length === 0
  )
    return row.summary ? [heading] : [];
  const scope = (g: PlanGroup): string => {
    if (g.fixes !== g.sites)
      return `${plural(g.fixes, 'fix', 'fixes')}, ${plural(g.sites, 'error')}`;
    const only = g.locations[0];
    // A single site is worth naming; the full path is in --details.
    return g.sites === 1 && only ? `${basename(only.file)}:${only.line}` : plural(g.sites, 'site');
  };
  // A package with dozens of distinct changes (a compiler API that was removed) gets its
  // largest ones here and the rest as a count: --details has every one.
  const listed = acting.length > MAX_RULE_LINES ? acting.slice(0, MAX_RULE_LINES - 1) : acting;
  const titleWidth = Math.max(...listed.map((g) => g.title.length), 0);
  const scopeWidth = Math.max(...listed.map((g) => scope(g).length), 0);
  const lines = [heading];
  for (const g of listed) {
    const mark = g.severity === 'breaking' ? colors.red('✗') : colors.magenta('?');
    lines.push(
      `  ${mark} ${pad(g.title, titleWidth)}   ${pad(scope(g), scopeWidth)}   ${colors.dim(byLabel(g))}`,
    );
    if (g.note) lines.push(colors.dim(`    ${g.note}`));
  }
  if (listed.length < acting.length) {
    const rest = acting.slice(listed.length);
    lines.push(
      colors.dim(
        `  … ${plural(rest.length, 'more change')}, ${plural(sitesOf(rest), 'site')} (--details)`,
      ),
    );
  }
  if (deprecated.length > 0) {
    const sites = sitesOf(deprecated);
    const byRule = deprecated.reduce((n, g) => n + g.by.rule, 0);
    const who = byRule > 0 ? BY.rule(byRule) : byLine(deprecated);
    lines.push(
      `  ${colors.yellow('!')} ${plural(sites, 'deprecated call')} (${deprecatedNames(deprecated)})   ${colors.dim(who)}`,
    );
  }
  // An importer the manifest does not show, or one the analysis could not reach: the reader
  // decides whether the sites above are all of them.
  for (const note of importers) lines.push(`  ${colors.yellow('⚠')} ${note}`);
  for (const note of peers) lines.push(`  ${colors.yellow('⚠')} peer: ${note}`);
  return lines;
}

/**
 * What the run left without an answer, and how to get one: dependencies the time budget
 * did not reach, and dependencies whose analysis failed, each with its reason.
 */
function notAnalyzed(report: CheckReport, opts: FormatCheckOptions, colors: Colors): string[] {
  const uptide = opts.invocation ?? 'npx uptide';
  const late = report.packages.filter((p) => p.skipReason === 'TIME_BUDGET');
  const failed = report.packages.filter((p) => isFailure(p));
  if (late.length === 0 && failed.length === 0) return [];
  const lines = [colors.bold('Not analyzed')];
  if (late.length > 0) {
    const budget = opts.maxTime ? ` (--max-time ${opts.maxTime})` : '';
    lines.push(
      `  ${colors.yellow('⚠')} ${late.length} behind, out of time${budget}: ${late
        .slice(0, 6)
        .map((p) => p.name)
        .join(', ')}${late.length > 6 ? `, and ${late.length - 6} more` : ''}`,
      colors.dim(
        `    ${uptide} check ${late
          .slice(0, 3)
          .map((p) => p.name)
          .join(' ')}    by name, no time limit`,
      ),
      colors.dim(`    ${uptide} list    discover upgrades, then check named packages`),
    );
  }
  // One line per cause: twenty dependencies lost to the same failure are one fact.
  const reasonOf = (p: PackageReport): string =>
    (p.notes[0] ?? 'analysis failed')
      .split('\n')[0]
      ?.replace(/ \(check it alone with --only \S+,/, ' (check one alone with --only,') ?? '';
  const byReason = new Map<string, PackageReport[]>();
  for (const p of failed) byReason.set(reasonOf(p), [...(byReason.get(reasonOf(p)) ?? []), p]);
  for (const [reason, group] of byReason) {
    const only = group[0] as PackageReport;
    lines.push(
      group.length === 1
        ? `  ${colors.red('✗')} ${only.name} ${only.installed}: ${(only.notes[0] ?? 'analysis failed').split('\n')[0]}`
        : `  ${colors.red('✗')} ${group.length} failed: ${reason}: ${group
            .slice(0, 6)
            .map((p) => p.name)
            .join(', ')}${group.length > 6 ? `, and ${group.length - 6} more` : ''}`,
    );
  }
  return lines;
}

/** The exact commands to run next in this repository, with what each one does. */
export function nextCommands(rows: Row[], opts: FormatCheckOptions): [string, string][] {
  const uptide = opts.invocation ?? 'npx uptide';
  const quote = (s: string) => (/^[\w./@:=+-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\"'\"'")}'`);
  const cwd = opts.repeat?.cwd ? ` --cwd ${quote(opts.repeat.cwd)}` : '';
  const commands: [string, string][] = [];
  const fixable = (name: string): boolean =>
    opts.fixable === true || (Array.isArray(opts.fixable) && opts.fixable.includes(name));
  for (const row of rows) {
    const name = row.p.name;
    // A release group is several packages: fix takes one.
    if (!fixable(name) || row.p.members) continue;
    if (commands.length >= FIX_SUGGESTIONS) break;
    const target = opts.repeat?.targets?.[name];
    const pinned = target ? ` --target ${quote(target)}` : '';
    if (row.plan.some((g) => g.severity !== 'deprecated'))
      commands.push([
        `${uptide} fix ${name}${pinned}${cwd}`,
        row.p.tier === 'generic'
          ? 'migrate with the agent on a new branch, verify, no push'
          : 'migrate on a new branch, verify, no push',
      ]);
    else if (row.p.tier !== 'generic' && row.plan.some((g) => g.by.rule > 0))
      commands.push([
        `${uptide} fix ${name}${pinned} --include-deprecated${cwd}`,
        'migrate the deprecated calls on a new branch, no push',
      ]);
  }
  const names = opts.repeat?.only?.split(',') ?? [
    ...new Set(rows.flatMap((r) => (r.p.members ?? [r.p]).map((p) => p.name))),
  ];
  const only = names.length ? ` ${names.map(quote).join(' ')}` : ' <package>';
  const planOnly = opts.repeat?.only ? ` --only ${quote(opts.repeat.only)}` : '';
  const targets = Object.entries(opts.repeat?.targets ?? {})
    .map(([name, version]) => ` --target ${quote(`${name}@${version}`)}`)
    .join('');
  if (rows.filter((r) => r.plan.length > 0).length > 1)
    commands.push([`${uptide} plan${planOnly}${cwd}`, 'the order to upgrade in, with the effort']);
  commands.push(
    opts.details
      ? [`${uptide} check${only}${targets}${cwd}`, 'the summary, one line per change']
      : [`${uptide} check${only}${targets} --details${cwd}`, 'every site and reason'],
  );
  return commands;
}

function nextLines(rows: Row[], opts: FormatCheckOptions, colors: Colors): string[] {
  const commands = nextCommands(rows, opts);
  const widest = Math.max(...commands.map(([command]) => command.length));
  return [
    colors.bold('Next'),
    ...commands.map(([command, what]) => `  ${pad(command, widest)}    ${colors.dim(what)}`),
  ];
}

export function checkRows(report: CheckReport, colors = pc.createColors(false)): Row[] {
  const multi = report.workspaces.length > 1;
  // What needs a decision comes first: most breaking sites, then unverified, then deprecated.
  const weight = (row: Row, severity: PlanGroup['severity']): number =>
    sitesOf(row.plan.filter((g) => g.severity === severity));
  return report.packages
    .map((p) => rowOf(p, multi, colors))
    .filter((row): row is Row => row !== undefined)
    .sort(
      (a, b) =>
        weight(b, 'breaking') - weight(a, 'breaking') ||
        weight(b, 'unverified') - weight(a, 'unverified') ||
        weight(b, 'deprecated') - weight(a, 'deprecated'),
    );
}

/**
 * The first screen of `check`: what was checked and how long it took, one row per dependency,
 * one line per change rule with who migrates it, and the commands to run next. Everything
 * else (sites, reasons, compiler messages, notes) is behind `--details`.
 */
const width = (text: string): number => text.replace(COLOR, '').length;
const pad = (text: string, to: number): string => text + ' '.repeat(Math.max(0, to - width(text)));

export function formatCheck(report: CheckReport, opts: FormatCheckOptions = {}): string {
  const colors = pc.createColors(opts.color ?? true);
  const lines: string[] = [];
  if (opts.header) {
    lines.push(terminalHeader('check', opts.header, opts.color ?? true), '');
  }
  const rows = checkRows(report, colors);
  if (opts.details) {
    lines.push(formatCheckDetails(report, { color: opts.color, all: opts.all }).trimEnd(), '');
  } else {
    // Where the target came from, next to how far it is: `major · latest on npm`. `fix`
    // resolves it the same way, so both commands name the same version for the same reason.
    const move = (row: Row): string =>
      [row.bump, targetSource(row.p, opts)].filter(Boolean).join(' · ');
    // A few no-impact rows are worth their line; dozens are one sentence.
    const quiet = rows.filter((r) => r.quiet);
    const folded = quiet.length > NO_IMPACT_ROWS ? quiet : [];
    const shown = rows.filter((r) => !folded.includes(r));
    lines.push(
      ...alignedRows(
        shown.map((row) => [
          { text: row.name, tone: 'bold' as const },
          { text: row.versions, alignAt: '→' },
          {
            text: move(row),
            tone: row.bump.startsWith('major') ? ('yellow' as const) : ('dim' as const),
          },
          { text: row.p.tier === 'verified' ? 'verified' : '', tone: 'green' as const },
          { text: row.verdict.replace(COLOR, '') },
          { text: row.by, tone: 'dim' as const },
        ]),
        opts.width ?? 160,
        opts.color ?? true,
      ),
    );
    if (folded.length > 0) {
      const named = folded.slice(0, 6).map((r) => r.p.name);
      // Folded, they still say what verified them: all compiled clean, or how many were not.
      const unverified = folded.filter((r) => r.p.verdict?.notVerified ?? !r.p.compile).length;
      const counted = folded.every((r) => r.p.compile?.newErrors === 0);
      const how =
        unverified > 0
          ? `${unverified} not verified by the compiler (--details)`
          : `compiled against their targets${counted ? ': 0 new type errors' : ''}`;
      lines.push(
        `${colors.green('✓')} ${folded.length} more with no impact on your code: ${named.join(', ')}${folded.length > named.length ? `, and ${folded.length - named.length} more` : ''} ${colors.dim(`· 0 breaking · ${how}`)}`,
      );
    }
    const missing = notAnalyzed(report, opts, colors);
    if (rows.length === 0 && missing.length === 0)
      lines.push(colors.dim('Nothing to upgrade: every checked dependency is up to date.'));
    if (rows.some((r) => r.p.tier === 'generic')) lines.push('', colors.dim(TIER_LEGEND));
    lines.push('');
    if (missing.length > 0) lines.push(...missing, '');
    for (const row of rows.filter((r) => !folded.includes(r))) {
      const section = sectionLines(row, colors);
      if (section.length > 0) lines.push(...section, '');
    }
  }
  lines.push(...nextLines(rows, opts, colors));
  return `${lines.join('\n')}\n`;
}
