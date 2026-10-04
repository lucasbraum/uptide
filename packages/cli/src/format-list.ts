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
const plural = (count: number, noun: string, multiple = `${noun}s`): string =>
  `${count} ${count === 1 ? noun : multiple}`;
const quote = (s: string): string =>
  /^[\w./@:=+-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\"'\"'")}'`;
const dependencyKey = (p: ListedDependency): string =>
  JSON.stringify([p.name, p.registryName ?? p.name, p.current]);
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
export function groupCount(group: ListGroup & { totalMembers?: number }): string {
  const total = group.totalMembers ?? group.members.length;
  return `${plural(total, 'package')}${total === group.members.length ? '' : ` (${group.members.length} in this section)`}`;
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
export const UNUSED_HINT = "no usage found by Uptide's scan; verify before removing";
export const listReasons = (p: ListedDependency): string[] =>
  p.reasons.filter(
    (reason) =>
      !p.peerOf?.some(
        (name) => reason === `required by ${name}` || reason === `peer dependency of ${name}`,
      ),
  );
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
  const groups = report.groups.filter((g) => groupLead(g)?.classification === 'used');
  const grouped = new Set(groups.flatMap((g) => g.members.map(dependencyKey)));
  const remaining = report.packages.filter((p) => !grouped.has(dependencyKey(p)));
  const isTooling = (p: ListedDependency): boolean =>
    p.classification === 'tooling' ||
    (p.classification === 'peer' &&
      report.groups.some(
        (g) =>
          g.members.some((m) => dependencyKey(m) === dependencyKey(p)) &&
          groupLead(g)?.classification === 'tooling',
      ));
  return {
    groups,
    used: remaining.filter((p) => p.classification === 'used'),
    tooling: remaining.filter(isTooling),
    unused: remaining.filter(
      (p) =>
        p.classification === 'possibly-unused' || (p.classification === 'peer' && !isTooling(p)),
    ),
  };
}
const groupLead = (group: ListGroup): ListedDependency | undefined =>
  group.members.find((p) => p.name === group.lead) ??
  group.members.find((p) => !p.peerOf) ??
  group.members[0];
/** Group rows inside a collapsed category too, preserving commands for the whole group. */
export function listBlocks(
  packages: ListedDependency[],
  report: ListReport,
): { id?: string; name?: string; members: ListedDependency[] }[] {
  const keys = new Set(packages.map((p) => dependencyKey(p)));
  // A group header belongs to its lead. Independently used members appear in their own
  // section, rather than inheriting an unused lead's classification. JSON retains all members.
  const groups = report.groups
    .filter((g) => {
      const lead = groupLead(g);
      return lead && keys.has(dependencyKey(lead));
    })
    .map((g) => ({
      ...g,
      totalMembers: g.members.length,
      members: g.members.filter((p) => keys.has(dependencyKey(p))),
    }));
  const grouped = new Set(groups.flatMap((g) => g.members.map((p) => dependencyKey(p))));
  return [
    ...groups,
    ...packages.filter((p) => !grouped.has(dependencyKey(p))).map((p) => ({ members: [p] })),
  ];
}
/** Group only identical registry failures; HTML keeps a named row for every package. */
export function listFailureLines(report: ListReport, details = false): string[] {
  const failures = [...new Map(report.failures.map((f) => [f.name, f])).values()];
  const buckets = new Map<string, typeof failures>();
  for (const failure of failures) {
    const key =
      failure.host && failure.summary
        ? JSON.stringify([failure.host, failure.status, failure.summary])
        : failure.name;
    buckets.set(key, [...(buckets.get(key) ?? []), failure]);
  }
  return [...buckets.values()].flatMap((members) => {
    const first = members[0];
    if (!first) return [];
    const denied = [401, 403, 405].includes(first.status ?? 0);
    if (first.host && first.summary && members.length > (denied ? 1 : 5))
      return [
        `? ${members.length} packages on ${first.host}: ${first.summary}, skipped`,
        ...(details ? members.map((f) => `    ${f.name}`) : []),
      ];
    return members.map((f) => `? ${f.name}: ${f.reason}`);
  });
}
export function skippedSources(
  report: ListReport,
): { reason: string; members: NonNullable<ListReport['skipped']> }[] {
  const groups = new Map<string, NonNullable<ListReport['skipped']>>();
  for (const item of report.skipped ?? [])
    groups.set(item.reason, [...(groups.get(item.reason) ?? []), item]);
  return [...groups]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([reason, members]) => ({ reason, members }));
}
/** Only use a reason-specific summary when every unknown has that same reason. */
export function notCheckedLabel(report: ListReport): string {
  const reasons = new Set(
    (report.unknown ?? []).map((unknown) => {
      const failure = report.failures.find((f) => f.name === unknown.name);
      if (failure?.status === 403) return 'access denied';
      if (failure?.status === 401) return 'auth required';
      if (failure?.status === 404) return 'not found';
      if (failure?.summary) return failure.summary.replace(/ \(\d{3}\)$/, '');
      const reason = failure?.reason ?? unknown.reason;
      return [
        'access denied',
        'auth required',
        'timed out',
        'not found',
        'network request failed',
      ].find((label) => reason.toLowerCase().includes(label));
    }),
  );
  const reason = reasons.size === 1 ? [...reasons][0] : undefined;
  return `not checked${reason ? ` (${reason})` : ''}`;
}
export function formatListTimings(report: ListReport, renderMs: number): string {
  const phases = report.timing.phases;
  const files = report.timing.files;
  if (!phases || !files) return `render ${Math.max(0, renderMs).toFixed(1)} ms\n`;
  return [
    `manifest read  ${phases.manifestReadMs.toFixed(1)} ms · ${plural(files.manifests, 'package manifest')} · ${plural(files.installedManifests, 'installed manifest')}`,
    `registry       ${phases.registryMs.toFixed(1)} ms`,
    `source scan    ${phases.sourceScanMs.toFixed(1)} ms · ${plural(files.source, 'source file')} · ${plural(files.assets, 'asset file')}${files.parsed === undefined ? '' : ` · ${files.parsed} parsed · ${files.workers || 0} workers`}`,
    `config scan    ${phases.configScanMs.toFixed(1)} ms · ${plural(files.config, 'config file')}`,
    `render         ${Math.max(0, renderMs).toFixed(1)} ms`,
    `files          ${files.visited} visited (pruned directory contents not enumerated)`,
    ...Object.entries(files.skipped ?? {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([reason, count]) =>
          `skipped        ${reason}: ${plural(count.files, 'file')} · ${plural(count.directories, 'directory', 'directories')}`,
      ),
    '',
  ].join('\n');
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
      ...(report.unknown?.length ? [stat(report.unknown.length, notCheckedLabel(report))] : []),
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
  const rows = new Map(shown.map((p, i) => [dependencyKey(p), formatted[i] as string]));
  const row = (p: ListedDependency): void => {
    lines.push(rows.get(dependencyKey(p)) ?? '');
    if (p.classification === 'tooling' || p.classification === 'possibly-unused')
      for (const reason of listReasons(p)) lines.push(c.dim(ellipsis(`    ${reason}`, width)));
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
            { text: groupCount(g) },
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
    ['POSSIBLY UNUSED', unused, UNUSED_HINT],
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
  for (const group of skippedSources(report)) {
    lines.push(
      c.dim(
        `${plural(group.members.length, 'package')} ${group.reason}${opts.all || opts.details ? '' : ' · --all'}`,
      ),
    );
    if (opts.all || opts.details)
      for (const item of group.members)
        lines.push(
          `  ${c.bold(item.name)}${showWorkspaces && opts.details ? c.dim(` · ${item.workspaces.join(', ')}`) : ''}`,
        );
  }
  if (report.skipped?.length) lines.push('');
  if (
    !report.packages.length &&
    !report.failures.length &&
    !report.unknown?.length &&
    !report.skipped?.length
  )
    lines.push('Every direct dependency is up to date.', '');
  lines.push(...listFailureLines(report, opts.details));
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
