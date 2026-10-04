import type { ListedDependency, ListGroup, ListReport } from '@uptide/core';
import { type CheckHeader, repoLine } from './format-check.js';
import { elapsed } from './progress.js';

export interface FormatListOptions {
  all?: boolean;
  details?: boolean;
  header?: CheckHeader;
  invocation?: string;
  cwd?: string;
}
const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;
const quote = (s: string): string =>
  /^[\w./@:=+-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\"'\"'")}'`;
export const listCommand = (packages: ListedDependency[], opts: FormatListOptions): string =>
  `${opts.invocation ?? 'npx uptide'} check ${[...new Set(packages.map((p) => p.name))].map(quote).join(' ')}${opts.cwd ? ` --cwd ${quote(opts.cwd)}` : ''}`;
export const listChange = (p: ListedDependency): string =>
  p.majorGap > 1 ? `major ×${p.majorGap}` : p.change;
export function listUsage(p: ListedDependency): string {
  const counts = [plural(p.usage.files, 'file')];
  if (p.usage.callSites) counts.push(plural(p.usage.callSites, 'call site'));
  if (p.usage.references)
    counts.push(p.usage.callSites ? plural(p.usage.references, 'reference') : 'referenced');
  else if (p.usage.files && !p.usage.callSites) counts.push('imported');
  return counts.join(', ');
}
export const listSymbols = (p: ListedDependency): string =>
  p.usage.topSymbols
    .filter((s) => s.count > 0)
    .map((s) => `${s.name} (${s.count})`)
    .join(', ');
export function listSections(report: ListReport): {
  groups: ListGroup[];
  used: ListedDependency[];
  tooling: ListedDependency[];
  unused: ListedDependency[];
} {
  // Groups containing source usage lead the report; tooling-only groups stay collapsed.
  const groups = report.groups.filter((g) => g.members.some((p) => p.classification === 'used'));
  const key = (p: ListedDependency): string => `${p.name}@${p.current}`;
  const grouped = new Set(groups.flatMap((g) => g.members.map(key)));
  const remaining = report.packages.filter((p) => !grouped.has(key(p)));
  return {
    groups,
    used: remaining.filter((p) => p.classification === 'used'),
    tooling: remaining.filter((p) => p.classification === 'tooling'),
    unused: remaining.filter((p) => p.classification === 'possibly-unused'),
  };
}
/** Group rows inside a collapsed category too, preserving commands for the whole group. */
export function listBlocks(
  packages: ListedDependency[],
  report: ListReport,
): { name?: string; members: ListedDependency[] }[] {
  const keys = new Set(packages.map((p) => `${p.name}@${p.current}`));
  const groups = report.groups.filter((g) =>
    g.members.every((p) => keys.has(`${p.name}@${p.current}`)),
  );
  const grouped = new Set(groups.flatMap((g) => g.members.map((p) => `${p.name}@${p.current}`)));
  return [
    ...groups,
    ...packages
      .filter((p) => !grouped.has(`${p.name}@${p.current}`))
      .map((p) => ({ members: [p] })),
  ];
}
export function formatList(report: ListReport, opts: FormatListOptions = {}): string {
  const lines = [
    `uptide list${opts.header ? ` · ${repoLine(opts.header)} · ${elapsed(opts.header.ms)}` : ''}`,
    '',
  ];
  const { groups, used, tooling, unused } = listSections(report);
  const showWorkspaces = report.workspaces.some((w) => w !== '.');
  const row = (p: ListedDependency): string =>
    `${p.name}  ${p.current} → ${p.latest}  ${listChange(p)} · ${p.tier} · ${listUsage(p)}${showWorkspaces ? ` · ${p.workspaces.join(', ')}` : ''}${listSymbols(p) ? `\n  top symbols: ${listSymbols(p)}` : ''}${opts.details && p.usage.fileList?.length ? `\n  files: ${p.usage.fileList.join(', ')}` : ''}`;
  for (const g of groups) {
    lines.push(`${g.name} · ${plural(g.members.length, 'package')} · check together`);
    for (const p of g.members) lines.push(`  ${row(p).replaceAll('\n', '\n  ')}`);
  }
  for (const p of used.filter((p) => opts.all || p.change === 'major')) lines.push(row(p));
  const collapsed = used.filter((p) => p.change !== 'major');
  if (!opts.all && collapsed.length)
    lines.push(
      `${collapsed.length} minor/patch upgrades (${collapsed.map((p) => p.name).join(', ')}) · --all to expand`,
    );
  for (const [label, packages] of [
    ['Tooling', tooling],
    ['Possibly unused', unused],
  ] as const) {
    if (!packages.length) continue;
    lines.push(
      '',
      `${label} · ${plural(packages.length, 'package')}${opts.all ? '' : ` (${packages.map((p) => p.name).join(', ')}) · --all to expand`}`,
    );
    if (opts.all)
      for (const block of listBlocks(packages, report)) {
        if (block.name)
          lines.push(`${block.name} · ${plural(block.members.length, 'package')} · check together`);
        for (const p of block.members) lines.push(`${block.name ? '  ' : ''}${row(p)}`);
      }
  }
  if (!report.packages.length && !report.failures.length)
    lines.push('Every direct dependency is up to date.');
  for (const f of report.failures)
    lines.push(
      `? ${f.name}${showWorkspaces && f.workspace ? ` (${f.workspace})` : ''}: ${f.reason}`,
    );
  lines.push(
    '',
    'Usage is a syntax scan: calls/new/JSX and references through imported bindings; no type analysis.',
  );
  const next =
    groups[0]?.members ??
    [used[0] ?? tooling[0] ?? unused[0]].filter((p): p is ListedDependency => !!p);
  if (next.length) {
    const group = report.groups.find((g) => g.members.some((p) => p.name === next[0]?.name));
    lines.push(`Next: ${listCommand(group?.members ?? next, opts)}`);
  }
  return `${lines.join('\n')}\n`;
}
