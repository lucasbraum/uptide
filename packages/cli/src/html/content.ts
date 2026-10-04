import type { CheckReport, PackageReport, PlanGroup } from '@uptide/core';
import type { Row } from '../format-check.js';

export function groupsForHtml(p: PackageReport, plan: PlanGroup[]): PlanGroup[] {
  const result: PlanGroup[] = [];
  for (const original of plan) {
    const g = structuredClone(original);
    if (g.severity === 'deprecated') {
      const formats = /(?:^|[#.])(email|uuid|url|datetime|base64)$/;
      const names = Object.keys(g.symbols ?? {});
      if (
        p.name === 'zod' &&
        (g.rule === 'string-format' ||
          formats.test(g.rule) ||
          (names.length > 0 && names.every((name) => formats.test(name))))
      ) {
        g.rule = 'string-format';
        g.title = 'Top-level string formats';
      } else if (plan.some((other) => other.severity === 'breaking' && other.title === g.title)) {
        g.title = `${names.join(', ') || g.rule} deprecated`;
      }
      const previous = result.find(
        (other) => other.severity === g.severity && other.rule === g.rule,
      );
      if (previous) {
        previous.sites += g.sites;
        previous.fixes += g.fixes;
        for (const key of ['rule', 'agent', 'manual'] as const) previous.by[key] += g.by[key];
        previous.locations = [
          ...new Map(
            [...previous.locations, ...g.locations].map((s) => [`${s.file}:${s.line}`, s]),
          ).values(),
        ];
        continue;
      }
    }
    result.push(g);
  }
  return result;
}
export function verdict(rows: Row[]): string {
  const groups = rows.flatMap((r) => r.plan);
  const breaking = groups.filter((g) => g.severity === 'breaking');
  const n = breaking.reduce((sum, g) => sum + g.sites, 0);
  const files = new Set(breaking.flatMap((g) => g.locations.map((s) => s.file))).size;
  const by = (key: 'rule' | 'agent' | 'manual') => breaking.reduce((sum, g) => sum + g.by[key], 0);
  const deprecated = groups
    .filter((g) => g.severity === 'deprecated')
    .reduce((sum, g) => sum + g.sites, 0);
  const unverified = groups
    .filter((g) => g.severity === 'unverified')
    .reduce((sum, g) => sum + g.sites, 0);
  return [
    n
      ? `${n} breaking ${n === 1 ? 'change' : 'changes'} in ${files} ${files === 1 ? 'file' : 'files'}.`
      : 'No confirmed breaking changes.',
    n
      ? `${by('rule')} fixable by rule, ${by('agent')} by agent${by('manual') ? `, ${by('manual')} manual` : ''}.`
      : '',
    deprecated
      ? `${deprecated} deprecated ${deprecated === 1 ? 'call' : 'calls'} (not blocking).`
      : '',
    unverified
      ? `${unverified} unverified ${unverified === 1 ? 'site' : 'sites'} need review.`
      : '',
  ]
    .filter(Boolean)
    .join(' ');
}
export function notesOf(report: CheckReport): string[] {
  const notes = new Set<string>();
  const skipped: string[] = [],
    baseline = new Map<number, string[]>();
  notes.add(`Workspaces analyzed: ${[...new Set(report.workspaces)].join(', ')}.`);
  for (const p of report.packages) {
    // Out of time has its own section; a gap in the analysis is something else.
    if (p.skipReason === 'TIME_BUDGET') continue;
    for (const note of p.notes) {
      if (/low.confidence|pre-existing|workspaces? (?:analyzed|skipped)/i.test(note)) continue;
      notes.add(note);
    }
    if (['skipped', 'no-types', 'private', 'unknown'].includes(p.status))
      skipped.push(
        `${p.workspaces?.join(', ') ?? p.workspace}: ${p.name} — ${p.skipReason ?? p.status}`,
      );
    if (p.compile?.baselineErrors) {
      const n = p.compile.baselineErrors;
      baseline.set(n, [...(baseline.get(n) ?? []), p.name]);
    }
    if (p.compile?.skipped) notes.add(`${p.name}: compile check skipped — ${p.compile.skipped}.`);
    if (p.compile?.unresolvedInTarget.length)
      notes.add(
        `${p.name}: ${p.compile.unresolvedInTarget.length} unresolved modules in target; results may be incomplete.`,
      );
    for (const s of p.unanalyzed)
      notes.add(`${p.name}: ${s.file}:${s.line} not analyzed (${s.kind}).`);
  }
  notes.add(`Workspace analysis gaps: ${[...new Set(skipped)].join('; ') || 'none reported'}.`);
  if (baseline.size === 1) {
    const n = [...baseline.keys()][0];
    notes.add(
      `${n} type ${n === 1 ? 'error that already existed before the upgrade was' : 'errors that already existed before the upgrade were'} ignored.`,
    );
  } else if (baseline.size > 1) {
    // Different package checks may share errors; their counts cannot safely be summed.
    notes.add(
      `Type errors that already existed before the upgrade were ignored: ${[...baseline].map(([n, names]) => `${n} in the ${[...new Set(names)].join(', ')} checks`).join('; ')}.`,
    );
  }
  return [...notes];
}
export function groupReason(g: PlanGroup): string {
  if (g.severity === 'deprecated')
    return g.rule === 'string-format'
      ? 'Use top-level string format schemas instead of chained string methods.'
      : g.detail || 'This API is deprecated; no replacement was supplied by the package.';
  const reasons: Record<string, string> = {
    'error-params':
      'Replace required_error and invalid_type_error with the new error parameter, preserving custom messages.',
    'api-version':
      'The configured API version does not match the target Stripe SDK. Review the API behavior changes before updating it.',
    types: 'Update the type references that are no longer supported by the target version.',
    ip: 'Replace the removed IP validator with the supported target API.',
  };
  return reasons[g.rule] ?? '';
}
export function stripeNote(note: string): string {
  return note.replace(
    /(none of the \d+ API changes since .+?) has evidence in your code/i,
    '$1 touch your code',
  );
}
