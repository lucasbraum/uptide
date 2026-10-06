import {
  buildToolMajor,
  type ListedDependency,
  type ListGroup,
  type ListReport,
  type Priority,
} from '@uptide/core';
import pc from 'picocolors';
import type { CheckHeader } from './format-check.js';
import { INVOCATION } from './invocation.js';
import { alignedRows, type Cell, ellipsis, terminalHeader, textWidth } from './terminal.js';

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
  `${opts.invocation ?? INVOCATION} check ${[...new Set(packages.map((p) => p.name))].map(quote).join(' ')}${opts.cwd ? ` --cwd ${quote(opts.cwd)}` : ''}`;
export const listChange = (p: ListedDependency): string =>
  p.majorGap > 1 ? `${p.majorGap} majors behind` : p.change;
/**
 * `5.0.52, 7.0.59 → 7.0.128`: the outdated installed versions, then the latest; past two,
 * the oldest and newest (`1.6.0 … 4.2.0`), the spread saying how many.
 */
export const listVersions = (p: ListedDependency): string => {
  const outdated = p.versions?.map((v) => v.version).filter((v) => v !== p.latest) ?? [p.current];
  const shown = outdated.length > 2 ? `${outdated[0]} … ${outdated.at(-1)}` : outdated.join(', ');
  return `${shown} → ${p.latest}`;
};
/** `2 versions in 3 workspaces`, when workspaces disagree on the installed version. */
export const listSpread = (p: ListedDependency): string =>
  p.versions
    ? `${p.versions.length} versions in ${plural(new Set(p.versions.flatMap((v) => v.workspaces)).size, 'workspace')}`
    : '';
export const groupCommand = (group: ListGroup, opts: FormatListOptions): string =>
  `${opts.invocation ?? INVOCATION} check --group ${quote(group.id)}${opts.cwd ? ` --cwd ${quote(opts.cwd)}` : ''}`;
/** The command that starts on a priority: its group or package, at its smallest fix when it has one. */
export const priorityCommand = (p: Priority, opts: FormatListOptions): string =>
  `${opts.invocation ?? INVOCATION} check ${p.group ? `--group ${quote(p.group)}` : p.packages.map(quote).join(' ')}${p.target ? ` --target ${quote(p.target)}` : ''}${opts.cwd ? ` --cwd ${quote(opts.cwd)}` : ''}`;
export const cheapBatchCommand = (names: string[], opts: FormatListOptions): string =>
  `${opts.invocation ?? INVOCATION} check ${names.map(quote).join(' ')}${opts.cwd ? ` --cwd ${quote(opts.cwd)}` : ''}`;
/** What the advisory lookup covered, for the PRIORITIES heading. */
export function advisoryStatus(report: ListReport): string {
  const a = report.advisories;
  if (!a) return 'advisories not checked';
  return a.status === 'checked'
    ? `advisories checked for ${plural(a.packages, 'package')}`
    : `advisories not checked${a.reason ? ` (${a.reason})` : ''}`;
}
/** A shortened cheap batch: the first few names, then how many more. */
export function cheapBatchLabel(names: string[], shown = 4): string {
  return `${names.slice(0, shown).join(', ')}${names.length > shown ? ` +${names.length - shown}` : ''}`;
}
export const PRIORITY_ROWS = 5;
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
/**
 * Where the group goes: `→ 12.x`, or each target major with what reaches it when they differ,
 * a family named once (`→ ai 7 · @ai-sdk/* 4`).
 */
export function groupVersions(group: ListGroup): string {
  const main = group.members.filter((p) => !p.peerOf);
  const byMajor = new Map<number, string[]>();
  for (const p of main) {
    const major = Number(p.latest.split('.')[0]);
    byMajor.set(major, [...new Set([...(byMajor.get(major) ?? []), p.name])]);
  }
  if (byMajor.size <= 1) return `→ ${[...byMajor.keys()][0]}.x`;
  const label = (names: string[]): string => {
    const scopes = new Set(names.map((n) => (n.startsWith('@') ? n.split('/')[0] : n)));
    const [scope] = scopes;
    return names.length > 1 && scopes.size === 1 && scope?.startsWith('@')
      ? `${scope}/*`
      : names.join(', ');
  };
  const majors = [...byMajor].sort(([a], [b]) => b - a);
  const labels = majors.map(([, names]) => label(names));
  const named = majors.map(([major], i) => `${labels[i]} ${major}`).join(' · ');
  // Names say what reaches each major, until two read the same (`@supabase/*` twice) or the
  // heading would run long (64 characters); then the majors alone.
  return new Set(labels).size === labels.length && named.length <= 64
    ? `→ ${named}`
    : `→ ${majors.map(([major]) => `${major}.x`).join(' · ')}`;
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
  if (!phases || !files)
    return [
      ...(report.scanWarnings ?? []),
      `render ${Math.max(0, renderMs).toFixed(1)} ms`,
      '',
    ].join('\n');
  return [
    `manifest read  ${phases.manifestReadMs.toFixed(1)} ms · ${plural(files.manifests, 'package manifest')} · ${plural(files.installedManifests, 'installed manifest')}`,
    `registry       ${phases.registryMs.toFixed(1)} ms`,
    `source scan    ${phases.sourceScanMs.toFixed(1)} ms · ${plural(files.source, 'source file')} · ${plural(files.assets, 'asset file')}${files.parsed === undefined ? '' : ` · ${files.parsed} parsed · ${files.workers || 0} workers`}`,
    `config scan    ${phases.configScanMs.toFixed(1)} ms · ${plural(files.config, 'config file')}`,
    `render         ${Math.max(0, renderMs).toFixed(1)} ms`,
    `files          ${files.visited} visited (built-in excluded directories not enumerated)`,
    ...(files.candidateSources === undefined
      ? []
      : [
          `source scope   ${files.candidateSources} candidates · ${files.ignoredSources ?? 0} excluded by .gitignore`,
        ]),
    ...(report.scanWarnings ?? []),
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
  // Warnings are prose, not table rows: wrap so the responsible rule is never clipped.
  for (const warning of report.scanWarnings ?? []) {
    let rest = warning;
    while (rest.length > width) {
      const space = rest.lastIndexOf(' ', width);
      const end = space > 0 ? space : width;
      lines.push(c.yellow(rest.slice(0, end)));
      rest = rest.slice(end).trimStart();
    }
    lines.push(c.yellow(rest), '');
  }
  const priorities = report.priorities ?? [];
  if (report.packages.length) {
    lines.push(
      `${c.bold('PRIORITIES')}  ${c.dim(`most urgent first · ${advisoryStatus(report)}`)}`,
    );
    const tone = (signal: Priority['signal']): Cell['tone'] =>
      signal === 'security'
        ? 'red'
        : signal === 'deprecated' || signal === 'unsupported'
          ? 'yellow'
          : undefined;
    const urgent = priorities.filter((p) => p.tier === 'urgent');
    const planning = priorities.filter((p) => p.tier !== 'urgent');
    const top = urgent.slice(0, opts.all ? urgent.length : PRIORITY_ROWS);
    const shownRows = [...top, ...(opts.all ? planning : [])];
    const longest = (texts: string[]): number => Math.max(0, ...texts.map((t) => t.length));
    // The command is the point of a row: on the same line when all of it fits, otherwise
    // under the name and reason, never clipped.
    const oneLine =
      4 +
        longest(shownRows.map((p) => p.name)) +
        3 +
        longest(shownRows.map((p) => p.reason)) +
        3 +
        longest(shownRows.map((p) => priorityCommand(p, opts))) <=
      width;
    const formatted = alignedRows(
      shownRows.map((p) => [
        { text: p.name, tone: 'bold' },
        { text: p.reason, ...(tone(p.signal) ? { tone: tone(p.signal) } : {}) },
        ...(oneLine ? [{ text: priorityCommand(p, opts), tone: 'dim' as const }] : []),
      ]),
      width,
      color,
      4,
    );
    const tierRows = (rows: Priority[], offset: number): void =>
      rows.forEach((p, i) => {
        lines.push(formatted[offset + i] as string);
        if (!oneLine) lines.push(c.dim(`      ${priorityCommand(p, opts)}`));
      });
    // Two tiers: what to act on now, then what to plan for, collapsed to its count.
    if (priorities.length) {
      lines.push(
        `  ${c.bold('Urgent')}  ${urgent.length}${c.dim(urgent.length ? ' · advisories, deprecations' : ' · no advisories or deprecations')}`,
      );
      tierRows(top, 0);
      if (top.length < urgent.length)
        lines.push(c.dim(`    + ${urgent.length - top.length} more · --all`));
      lines.push(
        `  ${c.bold('Worth planning')}  ${planning.length}${c.dim(` · unsupported, drift, blocking, majors behind${opts.all || !planning.length ? '' : ' · --all'}`)}`,
      );
      if (opts.all) tierRows(planning, top.length);
    }
    if (!priorities.length) {
      lines.push(
        `  Nothing urgent: no advisories, deprecations, unsupported lines or blocking peers.`,
      );
      if (report.cheapBatch?.length)
        lines.push(
          ...alignedRows(
            [
              [
                { text: 'cheap batch', tone: 'bold' },
                {
                  text: `${cheapBatchLabel(report.cheapBatch)}: minor/patch, few files, one PR`,
                },
                { text: cheapBatchCommand(report.cheapBatch, opts), tone: 'dim' },
              ],
            ],
            width,
            color,
            2,
          ),
        );
    }
    lines.push('');
  }
  const showWorkspaces = report.workspaces.some((w) => w !== '.');
  const cells = (p: ListedDependency): Cell[] => [
    { text: p.name, tone: 'bold' },
    { text: listVersions(p), alignAt: '→' },
    { text: listChange(p), tone: p.change === 'major' ? 'yellow' : 'dim' },
    {
      text: p.peerOf ? `peer of ${p.peerOf.join(', ')}` : plural(p.usage.files, 'file'),
      ...(p.peerOf ? { tone: 'dim' as const, span: 'rest' as const } : {}),
    },
    { text: !p.peerOf && p.usage.callSites ? plural(p.usage.callSites, 'call') : '' },
    { text: !p.peerOf && p.usage.references ? plural(p.usage.references, 'ref') : '' },
    { text: p.tier === 'verified' ? 'verified' : '', tone: 'green' },
    // Where it is installed: its workspaces, or how many versions in how many.
    ...(showWorkspaces
      ? [{ text: p.versions ? listSpread(p) : p.workspaces.join(', '), tone: 'dim' as const }]
      : []),
  ];
  // A compiler or bundler major is shown under TOOLING even when the section is collapsed.
  const buildMajors = tooling.filter((p) => buildToolMajor(p));
  const shown = [
    ...groups.flatMap((g) => g.members),
    ...used.filter((p) => opts.all || p.change === 'major'),
    ...(opts.all ? [...tooling, ...unused] : buildMajors),
  ];
  const formatted = alignedRows(shown.map(cells), width, color, 2);
  const rows = new Map(shown.map((p, i) => [dependencyKey(p), formatted[i] as string]));
  const row = (p: ListedDependency): void => {
    const rendered = rows.get(dependencyKey(p)) ?? '';
    lines.push(rendered);
    // The spread is the last column; when the width drops it, it goes under the row.
    if (p.versions && !rendered.includes(listSpread(p))) lines.push(c.dim(`    ${listSpread(p)}`));
    const build = buildToolMajor(p);
    if (build) lines.push(c.yellow(`    ${build}`));
    else if (p.classification === 'tooling' || p.classification === 'possibly-unused')
      for (const reason of listReasons(p)) lines.push(c.dim(ellipsis(`    ${reason}`, width)));
    if (opts.details && listSymbols(p))
      lines.push(c.dim(ellipsis(`    symbols  ${listSymbols(p)}`, width)));
    if (opts.details && p.usage.fileList?.length)
      for (const file of p.usage.fileList) lines.push(c.dim(ellipsis(`    ${file}`, width)));
  };
  const group = (g: ListGroup): void => {
    const command = groupCommand(g, opts);
    // Name, size and target always; the command on the same line when it fits, else under it.
    const head = `${c.bold(g.name)}${' '.repeat(Math.max(0, 12 - g.name.length))}   ${groupCount(g)}   ${groupVersions(g)}`;
    const fits = textWidth(head) + 3 + command.length <= width;
    lines.push(fits ? `${head}   ${c.dim(command)}` : head);
    if (!fits) lines.push(c.dim(`    ${command}`));
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
    if (!opts.all && label === 'TOOLING') for (const p of buildMajors) row(p);
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
  // Next is the top priority; with nothing urgent, the cheap batch; then the first row.
  const first = used[0] ?? tooling[0] ?? unused[0];
  const next =
    groups[0] ?? report.groups.find((g) => g.members.some((p) => p.name === first?.name));
  const nextCommand = priorities[0]
    ? priorityCommand(priorities[0], opts)
    : report.cheapBatch?.length
      ? cheapBatchCommand(report.cheapBatch, opts)
      : next
        ? groupCommand(next, opts)
        : first
          ? listCommand([first], opts)
          : undefined;
  if (nextCommand) lines.push(`${c.bold('Next')}  ${nextCommand}`);
  // Hints and headings also obey the terminal width; never emit a wrapped table row.
  return `${lines
    .join('\n')
    .split('\n')
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
