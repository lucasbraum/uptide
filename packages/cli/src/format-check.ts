import { basename } from 'node:path';
import { type CheckReport, type PackageReport, type PlanGroup, planPackage } from '@uptide/core';
import pc from 'picocolors';
import { formatCheckDetails } from './format-check-details.js';
import { importerNotes } from './importers.js';
import { elapsed } from './progress.js';

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
  /** Every site, reason, raw compiler message and note instead of one line per rule. */
  details?: boolean;
  /** With `details`: findings under 50% confidence too. */
  all?: boolean;
  header?: CheckHeader;
  /** How this build is invoked from a shell: `npx uptide@next`. */
  invocation?: string;
  /** Flags to repeat in the suggested commands so they act on the same repository and scope. */
  repeat?: { cwd?: string; only?: string; targets?: Record<string, string> };
  /** Packages `fix` can migrate in this repository (a pack exists and the manager is supported). */
  fixable?: readonly string[];
}

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
  return a[0] !== b[0] ? 'major' : a[1] !== b[1] ? 'minor' : a[2] !== b[2] ? 'patch' : '';
}

/** `21 by rule · 4 by agent`: who migrates the sites, in the words `fix` reports them with. */
export function byLine(groups: PlanGroup[]): string {
  const total = { rule: 0, agent: 0, manual: 0 };
  for (const g of groups) {
    total.rule += g.by.rule;
    total.agent += g.by.agent;
    total.manual += g.by.manual;
  }
  return [
    total.rule > 0 ? `${total.rule} by rule` : '',
    total.agent > 0 ? `${total.agent} by agent` : '',
    total.manual > 0 ? `${total.manual} manual` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

const byLabel = (g: PlanGroup): string =>
  [
    g.by.rule > 0 ? 'by rule' : '',
    g.by.agent > 0 ? 'by agent' : '',
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
}

/** Packages with nothing to decide (never imported, linked, private, up to date) have no row. */
function rowOf(p: PackageReport, multi: boolean, colors: Colors): Row | undefined {
  if (['not-imported', 'workspace', 'private'].includes(p.status)) return undefined;
  if (p.notes.includes('up to date')) return undefined;
  const plan = planOf(p);
  const of = (severity: PlanGroup['severity']): PlanGroup[] =>
    plan.filter((g) => g.severity === severity);
  const [breaking, unverified, deprecated] = [of('breaking'), of('unverified'), of('deprecated')];
  const where =
    multi && p.workspace !== '*' && p.workspace !== '.' ? colors.dim(` (${p.workspace})`) : '';
  const members = p.members ? ` (${plural(p.members.length, 'package')})` : '';
  const unanalyzed = p.unanalyzed.length;
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
    verdict = `${colors.red('✗')} ${sites} breaking${sites > 1 ? ` in ${plural(files, 'file')}` : ''}${extra}`;
    by = byLine([...breaking, ...unverified]);
  } else if (unverified.length > 0) {
    verdict = `${colors.magenta('?')} ${sitesOf(unverified)} unverified`;
    by = byLine(unverified);
  } else if (deprecated.length > 0) {
    verdict = `${colors.yellow('!')} ${sitesOf(deprecated)} deprecated`;
    by = byLine(deprecated);
  } else if (p.status === 'unknown') {
    verdict = `${colors.magenta('?')} ${unanalyzed} of ${plural(p.callSitesChecked + unanalyzed, 'site')} not analyzed`;
  } else if (unanalyzed > 0) {
    verdict = `${colors.green('✓')} no impact in ${plural(p.callSitesChecked, 'site')}, ${unanalyzed} not analyzed`;
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
  };
}

/** Color codes start with the escape character and take no column. */
const COLOR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const width = (text: string): number => text.replace(COLOR, '').length;
const pad = (text: string, to: number): string => text + ' '.repeat(Math.max(0, to - width(text)));

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
  if (acting.length === 0 && deprecated.length === 0 && importers.length === 0) return [];
  const scope = (g: PlanGroup): string => {
    if (g.fixes !== g.sites)
      return `${plural(g.fixes, 'fix', 'fixes')}, ${plural(g.sites, 'error')}`;
    const only = g.locations[0];
    // A single site is worth naming; the full path is in --details.
    return g.sites === 1 && only ? `${basename(only.file)}:${only.line}` : plural(g.sites, 'site');
  };
  const titleWidth = Math.max(...acting.map((g) => g.title.length), 0);
  const scopeWidth = Math.max(...acting.map((g) => scope(g).length), 0);
  const lines = [colors.bold(row.p.name)];
  for (const g of acting) {
    const mark = g.severity === 'breaking' ? colors.red('✗') : colors.magenta('?');
    lines.push(
      `  ${mark} ${pad(g.title, titleWidth)}   ${pad(scope(g), scopeWidth)}   ${colors.dim(byLabel(g))}`,
    );
    if (g.note) lines.push(colors.dim(`    ${g.note}`));
  }
  if (deprecated.length > 0) {
    const sites = sitesOf(deprecated);
    const byRule = deprecated.reduce((n, g) => n + g.by.rule, 0);
    const who = byRule > 0 ? `${byRule} by rule` : byLine(deprecated);
    lines.push(
      `  ${colors.yellow('!')} ${plural(sites, 'deprecated call')} (${deprecatedNames(deprecated)})   ${colors.dim(who)}`,
    );
  }
  // An importer the manifest does not show, or one the analysis could not reach: the reader
  // decides whether the sites above are all of them.
  for (const note of importers) lines.push(`  ${colors.yellow('⚠')} ${note}`);
  return lines;
}

/** The exact commands to run next in this repository, with what each one does. */
export function nextCommands(rows: Row[], opts: FormatCheckOptions): [string, string][] {
  const uptide = opts.invocation ?? 'npx uptide';
  const quote = (s: string) => (/^[\w./@:=+-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\"'\"'")}'`);
  const cwd = opts.repeat?.cwd ? ` --cwd ${quote(opts.repeat.cwd)}` : '';
  const commands: [string, string][] = [];
  for (const row of rows) {
    const name = row.p.name;
    if (!opts.fixable?.includes(name)) continue;
    const target = opts.repeat?.targets?.[name];
    const pinned = target ? ` --target ${quote(target)}` : '';
    if (row.plan.some((g) => g.severity !== 'deprecated'))
      commands.push([
        `${uptide} fix --only ${name}${pinned}${cwd}`,
        'migrate on a new branch, verify, no push',
      ]);
    else if (row.plan.some((g) => g.by.rule > 0))
      commands.push([
        `${uptide} fix --only ${name}${pinned} --include-deprecated${cwd}`,
        'migrate the deprecated calls on a new branch, no push',
      ]);
  }
  const only = opts.repeat?.only ? ` --only ${quote(opts.repeat.only)}` : '';
  const targets = Object.entries(opts.repeat?.targets ?? {})
    .map(([name, version]) => ` --target ${quote(`${name}@${version}`)}`)
    .join('');
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
export function formatCheck(report: CheckReport, opts: FormatCheckOptions = {}): string {
  const colors = pc.createColors(opts.color ?? true);
  const lines: string[] = [];
  if (opts.header) {
    const dot = colors.dim('·');
    lines.push(
      `${colors.bold('uptide check')} ${dot} ${repoLine(opts.header)} ${dot} ${elapsed(opts.header.ms)}`,
      '',
    );
  }
  const rows = checkRows(report, colors);
  if (opts.details) {
    lines.push(formatCheckDetails(report, { color: opts.color, all: opts.all }).trimEnd(), '');
  } else {
    const col = (pick: (row: Row) => string): number =>
      Math.max(...rows.map((r) => width(pick(r))), 0);
    // Where the target came from, next to how far it is: `major · latest on npm`. `fix`
    // resolves it the same way, so both commands name the same version for the same reason.
    const move = (row: Row): string =>
      [row.bump, targetSource(row.p, opts)].filter(Boolean).join(' · ');
    const [names, versions, bumps] = [col((r) => r.name), col((r) => r.versions), col(move)];
    // Only rows that say who migrates them set the width of the verdict column.
    const verdicts = Math.max(...rows.filter((r) => r.by).map((r) => width(r.verdict)), 0);
    for (const row of rows)
      lines.push(
        `${pad(colors.bold(row.name), names)}  ${pad(row.versions, versions)}   ${pad(colors.dim(move(row)), bumps)}   ${row.by ? `${pad(row.verdict, verdicts)}    ${colors.dim(row.by)}` : row.verdict}`,
      );
    if (rows.length === 0)
      lines.push(colors.dim('Nothing to upgrade: every checked dependency is up to date.'));
    lines.push('');
    for (const row of rows) {
      const section = sectionLines(row, colors);
      if (section.length > 0) lines.push(...section, '');
    }
  }
  lines.push(...nextLines(rows, opts, colors));
  return `${lines.join('\n')}\n`;
}
