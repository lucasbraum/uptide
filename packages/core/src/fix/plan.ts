import type { Finding, PackageReport, PlanGroup } from '../domain/report.js';
import type { MigrationPack, PackContext } from '../packs/types.js';
import { changeRule, diagnosticTitle, RULE_TITLES, ruleTitle } from './report.js';
import { selectedFindings } from './select.js';

type Outcome = 'mechanical' | 'agent' | 'manual';
interface Planned {
  finding: Finding;
  outcome: Outcome;
  rule: string;
}

/** Findings under this confidence are not shown or counted by default. */
const VISIBLE_CONFIDENCE = 0.5;

/**
 * What `fix` would do with a package's findings, without touching a file: the same site list
 * (`selectedFindings`), the pack's own transform as a dry run, the same rule ids as the PR
 * body. A site the transform takes is "by rule"; any other site of a supported upgrade goes
 * to the assisted fixer; without a pack the confirmed breaking sites go to the agent and
 * everything else is manual.
 */
export function planPackage(
  p: PackageReport,
  pack?: MigrationPack,
  read: (file: string) => string | undefined = () => undefined,
  /** What the pack gathered for this package (API versions, evidence): the dry run sees it too. */
  context: Partial<PackContext> = {},
): PlanGroup[] {
  const usable = pack !== undefined && pack.name === p.name && pack.supports(p.installed, p.target);
  const visible: PackageReport = {
    ...p,
    findings: p.findings.filter((f) => f.confidence >= VISIBLE_CONFIDENCE),
  };
  const selected = selectedFindings(
    { repo: '', workspaces: [], packages: [visible], summary: emptySummary },
    p.name,
    true,
  );
  const planned: Planned[] = selected.map((finding) => {
    const source = usable ? read(finding.usage.file) : undefined;
    const dry =
      usable && source !== undefined
        ? pack.transform(source, finding, {
            ...context,
            from: finding.change.from,
            to: p.target,
            includeDeprecated: true,
          })
        : undefined;
    // A pack's own finding marked manual is a decision, not a site anyone migrates unasked.
    const decision = finding.change.source === 'pack' && finding.fixability === 'manual';
    // Without a pack, `fix` hands the sites that have evidence to the agent; the rest is a
    // person's call.
    const generic = !usable && finding.severity === 'breaking';
    const outcome: Outcome = dry?.applied
      ? 'mechanical'
      : (usable && !decision) || generic
        ? 'agent'
        : 'manual';
    const rule =
      finding.rule ??
      dry?.rule ??
      changeRule({ package: p.name }, { finding, outcome, reason: dry?.reason ?? finding.reason });
    return { finding, outcome, rule };
  });
  // A compiler-only error next to a per-file rule is resolved by that rule's one edit.
  const perFile = new Set((usable ? pack.rules : []).filter((r) => r.perFile).map((r) => r.id));
  for (const site of planned) {
    if (site.outcome === 'mechanical' || !/^TS\d+$/.test(site.rule)) continue;
    const anchor = planned.find(
      (other) =>
        perFile.has(other.rule) &&
        other.finding.severity === site.finding.severity &&
        other.finding.usage.file === site.finding.usage.file,
    );
    if (anchor) site.rule = anchor.rule;
  }
  const groups = new Map<string, Planned[]>();
  for (const site of planned) {
    const key = `${site.finding.severity}:${site.rule}`;
    groups.set(key, [...(groups.get(key) ?? []), site]);
  }
  const order = { breaking: 0, unverified: 1, deprecated: 2 } as const;
  return [...groups.values()]
    .map((sites): PlanGroup => {
      const first = sites[0] as Planned;
      const severity = first.finding.severity as PlanGroup['severity'];
      const count = (o: Outcome): number => sites.filter((s) => s.outcome === o).length;
      const assisted = sites.filter((s) => s.outcome !== 'mechanical');
      const group: PlanGroup = {
        rule: first.rule,
        title: titleOf(first.rule, sites),
        severity,
        by: { rule: count('mechanical'), agent: count('agent'), manual: count('manual') },
        sites: sites.length,
        fixes: perFile.has(first.rule)
          ? count('mechanical') + new Set(assisted.map((s) => s.finding.usage.file)).size
          : sites.length,
        locations: sites
          .map((s) => ({ file: s.finding.usage.file, line: s.finding.usage.line }))
          .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line),
        detail: (first.finding.usage.compileError ?? first.finding.reason).split('\n')[0] ?? '',
      };
      if (severity === 'deprecated') {
        const symbols: Record<string, number> = {};
        for (const s of sites) {
          const name = written(s.finding.change.path);
          symbols[name] = (symbols[name] ?? 0) + 1;
        }
        group.symbols = symbols;
      }
      return group;
    })
    .sort(
      (a, b) =>
        order[a.severity] - order[b.severity] ||
        Number(a.by.rule === 0) - Number(b.by.rule === 0) ||
        b.sites - a.sites ||
        a.rule.localeCompare(b.rule),
    );
}

const emptySummary = {
  packagesNeedingAttention: 0,
  breaking: 0,
  deprecated: 0,
  unverified: 0,
  unaffected: 0,
  notImported: 0,
  partiallyAnalyzed: 0,
  autoFixable: 0,
  skippedForTime: 0,
  failed: 0,
};

/** `ZodString#email` as the consumer writes it: `.email`. A top-level name stays as it is. */
function written(path: string): string {
  const member = /[#.]([^#.[(]+)(?:\(\))?$/.exec(path);
  return member && path.includes('#') ? `.${member[1]}` : path;
}

/** The PR body's wording when the rule is known; plain English for everything else. */
function titleOf(rule: string, sites: Planned[]): string {
  const evidence = sites
    .map(
      (s) =>
        `${s.finding.change.path} ${s.finding.usage.compileError ?? ''} ${s.finding.usage.snippet}`,
    )
    .join(' ');
  const known = RULE_TITLES[rule]?.plain ?? ruleTitle(rule, /ZodTypeDef/.test(evidence));
  if (known) return known.replaceAll('`', '');
  const first = (sites[0] as Planned).finding;
  const code = /^TS(\d+)$/.exec(rule);
  if (code)
    return diagnosticTitle(
      Number(code[1]),
      sites.map((s) => s.finding),
    );
  const c = first.change;
  // The diff names the symbol whose declaration moved; when the compiler rejected every site,
  // its message says what actually broke there, which is what the reader needs.
  const compiled = sites.every((s) => s.finding.usage.compileCode !== undefined);
  if (compiled && !['removed', 'renamed', 'moved', 'module-format', 'deprecated'].includes(c.kind))
    return diagnosticTitle(
      first.usage.compileCode as number,
      sites.map((s) => s.finding),
    );
  switch (c.kind) {
    case 'removed':
      return `${rule} removed`;
    case 'renamed':
      return `${rule} renamed${c.replacement ? ` to ${c.replacement}` : ''}`;
    case 'moved':
      return `${rule} moved to ${c.replacement ?? 'another entry point'}`;
    case 'required':
      return `${rule} is now required`;
    case 'signature':
      return `${rule} takes different arguments`;
    case 'module-format':
      return `${c.package} is ESM-only: require() no longer loads it`;
    case 'deprecated':
      return `${rule} deprecated`;
    default:
      return `${rule} changed type`;
  }
}
