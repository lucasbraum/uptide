import type { ListedDependency, ListGroup, ListReport } from '@uptide/core';
import pc from 'picocolors';
import type { CheckHeader } from './format-check.js';
import { alignedRows, type Cell, ellipsis, terminalHeader } from './terminal.js';

export interface FormatListOptions {
  all?: boolean;
  color?: boolean;
  width?: number;
  details?: boolean;
  header?: CheckHeader;
  invocation?: string;
  cwd?: string;
}
const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;
const quote = (s: string): string =>
  /^[\w./@:=+-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\"'\"'")}'`;
export const listCommand = (packages: ListedDependency[], opts: FormatListOptions): string =>
  `${opts.invocation ?? 'uptide'} check ${[...new Set(packages.map((p) => p.name))].map(quote).join(' ')}${opts.cwd ? ` --cwd ${quote(opts.cwd)}` : ''}`;
export const listChange = (p: ListedDependency): string =>
  p.majorGap > 1 ? `major ×${p.majorGap}` : p.change;
export const groupCommand = (group: ListGroup, opts: FormatListOptions): string =>
  `${opts.invocation ?? 'uptide'} check --group ${quote(group.id)}${opts.cwd ? ` --cwd ${quote(opts.cwd)}` : ''}`;
export function listUsage(p: ListedDependency): string {
  return [
    plural(p.usage.files, 'file'),
    p.usage.callSites ? plural(p.usage.callSites, 'call') : '',
    p.usage.references ? plural(p.usage.references, 'reference') : '',
  ]
    .filter(Boolean)
    .join(' · ');
}
export function groupVersions(group: ListGroup): string {
  const main = group.members.filter((p) => !p.peerOf);
  const range = (): string => {
    const majors = [...new Set(main.map((p) => Number(p.latest.split('.')[0])))].sort(
      (a, b) => a - b,
    );
    return majors.length > 1 ? `${majors[0]}–${majors.at(-1)}.x` : `${majors[0]}.x`;
  };
  return `→ ${range()}`;
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
  const toolingKeys = new Set(remaining.filter((p) => p.classification === 'tooling').map(key));
  for (const group of report.groups) {
    if (!groups.includes(group) && group.members.some((p) => toolingKeys.has(key(p))))
      for (const p of group.members) toolingKeys.add(key(p));
  }
  return {
    groups,
    used: remaining.filter((p) => p.classification === 'used'),
    tooling: remaining.filter((p) => toolingKeys.has(key(p))),
    unused: remaining.filter((p) => !toolingKeys.has(key(p)) && p.classification !== 'used'),
  };
}
/** Group rows inside a collapsed category too, preserving commands for the whole group. */
export function listBlocks(
  packages: ListedDependency[],
  report: ListReport,
): { id?: string; name?: string; members: ListedDependency[] }[] {
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
  const color = opts.color ?? false;
  const c = pc.createColors(color);
  const width = Math.max(24, opts.width ?? 120);
  const { groups, used, tooling, unused } = listSections(report);
  const lines = [
    opts.header ? terminalHeader('list', opts.header, color) : c.bold('uptide list'),
    '',
  ];
  const stat = (n: number, label: string): string => `${c.bold(String(n))} ${label}`;
  lines.push(
    [
      stat(report.packages.length, 'outdated'),
      stat(report.packages.filter((p) => p.change === 'major').length, 'major'),
      stat(report.packages.filter((p) => p.change === 'minor').length, 'minor'),
      ...(report.packages.some((p) => p.change === 'patch')
        ? [stat(report.packages.filter((p) => p.change === 'patch').length, 'patch')]
        : []),
      stat(groups.length, groups.length === 1 ? 'group' : 'groups'),
      stat(tooling.length, 'tooling'),
    ].join('   '),
    '',
  );
  const showWorkspaces = report.workspaces.some((w) => w !== '.');
  const cells = (p: ListedDependency): Cell[] => [
    { text: p.name, tone: 'bold' },
    { text: `${p.current} → ${p.latest}`, alignAt: '→' },
    { text: listChange(p), tone: p.change === 'major' ? 'yellow' : 'dim' },
    {
      text: p.peerOf ? `peer of ${p.peerOf.join(', ')}` : plural(p.usage.files, 'file'),
      ...(p.peerOf ? { tone: 'dim' as const, span: 'rest' as const } : {}),
    },
    { text: !p.peerOf && p.usage.callSites ? plural(p.usage.callSites, 'call') : '' },
    { text: !p.peerOf && p.usage.references ? plural(p.usage.references, 'ref') : '' },
    { text: p.tier === 'verified' ? 'verified' : '', tone: 'green' },
    ...(showWorkspaces ? [{ text: p.workspaces.join(', '), tone: 'dim' as const }] : []),
  ];
  const shown = [
    ...groups.flatMap((g) => g.members),
    ...used.filter((p) => opts.all || p.change === 'major'),
    ...(opts.all ? [...tooling, ...unused] : []),
  ];
  const formatted = alignedRows(shown.map(cells), width, color, 2);
  const rows = new Map(shown.map((p, i) => [`${p.name}@${p.current}`, formatted[i] as string]));
  const row = (p: ListedDependency): void => {
    lines.push(rows.get(`${p.name}@${p.current}`) ?? '');
    if (opts.details && listSymbols(p))
      lines.push(c.dim(ellipsis(`    symbols  ${listSymbols(p)}`, width)));
    if (opts.details && p.usage.fileList?.length)
      for (const file of p.usage.fileList) lines.push(c.dim(ellipsis(`    ${file}`, width)));
  };
  const group = (g: ListGroup): void => {
    lines.push(
      ...alignedRows(
        [
          [
            { text: g.name, tone: 'bold' },
            { text: plural(g.members.length, 'package') },
            { text: groupVersions(g) },
            { text: groupCommand(g, opts), tone: 'dim' },
          ],
        ],
        width,
        color,
      ),
    );
    for (const p of g.members) row(p);
  };
  if (groups.length) {
    lines.push(`${c.bold('GROUPS')}  ${c.dim('upgrade together')}`);
    for (const g of groups) group(g);
    lines.push('');
  }
  if (used.length) {
    lines.push(c.bold('PACKAGES'));
    for (const p of used.filter((p) => opts.all || p.change === 'major')) row(p);
    const count = used.filter((p) => p.change !== 'major').length;
    if (!opts.all && count) lines.push(c.dim(`  + ${count} minor/patch · --all`));
    lines.push('');
  }
  for (const [label, packages, hint] of [
    ['TOOLING', tooling, 'used by scripts and config'],
    ['POSSIBLY UNUSED', unused, 'no source or tooling usage found'],
  ] as const) {
    if (!packages.length) continue;
    lines.push(
      `${c.bold(label)}  ${c.dim(`${plural(packages.length, 'package')}, ${hint}${opts.all ? '' : ' · --all'}`)}`,
    );
    if (opts.all)
      for (const block of listBlocks(packages, report)) {
        if (block.name) group(block as ListGroup);
        else for (const p of block.members) row(p);
      }
    lines.push('');
  }
  if (!report.packages.length && !report.failures.length)
    lines.push('Every direct dependency is up to date.', '');
  for (const f of report.failures) lines.push(`? ${f.name}: ${f.reason}`);
  lines.push(
    c.dim('Usage is a syntax scan, no type analysis.'),
    c.dim('Generic analysis is the default; verified means a migration pack is available.'),
  );
  const first = used[0] ?? tooling[0] ?? unused[0];
  const next =
    groups[0] ?? report.groups.find((g) => g.members.some((p) => p.name === first?.name));
  if (next || first)
    lines.push(
      `${c.bold('Next')}  ${next ? groupCommand(next, opts) : listCommand([first as ListedDependency], opts)}`,
    );
  // Hints and headings also obey the terminal width; never emit a wrapped table row.
  return `${lines
    .map((line) => {
      // Preserve ANSI while clipping the plain portions of long headings.
      let visible = 0;
      const parts = line.split(new RegExp(`(${String.fromCharCode(27)}\\[[0-9;]*m)`));
      if (parts.filter((p) => !p.startsWith('\x1b')).join('').length <= width) return line;
      return `${parts
        .map((part) => {
          if (part.startsWith('\x1b')) return part;
          const left = Math.max(0, width - 1 - visible);
          const result = Array.from(part).slice(0, left).join('');
          visible += Array.from(part).length;
          return result;
        })
        .join('')}…`;
    })
    .join('\n')}\n`;
}
