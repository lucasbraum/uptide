import { basename } from 'node:path';
import type { ListedDependency, ListGroup, ListReport } from '@uptide/core';
import {
  advisoryStatus,
  cheapBatchCommand,
  cheapBatchLabel,
  type FormatListOptions,
  groupCommand,
  groupCount,
  groupVersions,
  listBlocks,
  listChange,
  listCommand,
  listReasons,
  listSections,
  listSymbols,
  listUsage,
  notCheckedLabel,
  priorityCommand,
  UNUSED_HINT,
} from '../format-list.js';
import { escapeHtml as e } from './escape.js';
import {
  reportCommand,
  reportCopyButton,
  reportDocument,
  reportHeader,
  reportStats,
  sectionLabel,
} from './template.js';
import { writeReportHtml } from './write.js';

export interface ListHtmlOptions extends FormatListOptions {
  version: string;
  date: string;
  timeZone?: string;
}
/** Where a row is shown; the Groups, Tooling and Possibly unused filters read it. */
type Section = 'group' | 'used' | 'tooling' | 'unused';
export function renderListHtml(report: ListReport, opts: ListHtmlOptions): string {
  const { groups, used, tooling, unused } = listSections(report);
  const failures = [...new Map(report.failures.map((f) => [f.name, f])).values()];
  let section = 0;
  const nextSection = (): string => String(++section).padStart(2, '0');
  const commands = { ...opts, cwd: opts.details ? opts.cwd : undefined };
  const priorities = report.priorities ?? [];
  const urgent = new Set(priorities.flatMap((p) => p.packages));
  // Every package is one row, in exactly one section: a tile's count is the rows it shows.
  const row = (p: ListedDependency, where: Section, command?: string): string =>
    `<article class="member-grid${command ? ' has-command' : ''}" data-change="${p.change}" data-section="${where}"${urgent.has(p.name) ? ' data-priority' : ''}${p.tier === 'verified' ? ' data-verified' : ''}><div class="pkg-name">${e(p.name)}${p.tier === 'verified' ? '<span class="verified">verified</span>' : ''}</div><div class="versions">${e(p.current)} → ${e(p.latest)}</div><div class="gap">${e(listChange(p))}</div><div class="usage${p.peerOf ? ' muted' : ''}">${p.peerOf ? `peer of ${e(p.peerOf.join(', '))}` : e(listUsage(p))}</div>${command ? reportCopyButton(command) : ''}${(p.classification === 'tooling' || p.classification === 'possibly-unused') && listReasons(p).length ? `<div class="details-line">${listReasons(p).map(e).join(' · ')}</div>` : ''}${opts.details && listSymbols(p) ? `<div class="details-line">Top symbols: ${e(listSymbols(p))}</div>` : ''}${opts.details && p.usage.fileList?.length ? `<details class="details-line"><summary>Files</summary><ul>${p.usage.fileList.map((file) => `<li>${e(file)}</li>`).join('')}</ul></details>` : ''}</article>`;
  const group = (g: ListGroup, where: Section): string =>
    `<section class="package"${where === 'group' ? ' data-group' : ''}><header><h2>${e(g.name)}</h2><div class="meta"><span>${e(groupCount(g))}</span><span>${e(groupVersions(g))}</span>${g.reason ? `<span>${e(g.reason)}</span>` : ''}</div>${reportCommand(groupCommand(g, commands))}</header>${g.members.map((p) => row(p, where)).join('')}</section>`;
  const standalone = (p: ListedDependency, where: Section): string =>
    row(p, where, listCommand([p], commands));
  const collapsed = (label: string, packages: ListedDependency[], where: Section): string =>
    packages.length
      ? `<details class="notes" data-block><summary>${nextSection()} / ${label} / ${packages.length} package${packages.length === 1 ? '' : 's'}</summary>${label === 'Possibly unused' ? `<p class="more">${e(UNUSED_HINT)}</p>` : ''}${listBlocks(
          packages,
          report,
        )
          .map((block) =>
            block.name
              ? group(block as ListGroup, where)
              : block.members.map((p) => standalone(p, where)).join(''),
          )
          .join('')}</details>`
      : '';
  const priorityBlock = (): string => {
    if (!report.packages.length) return '';
    const rows = priorities.length
      ? `<ol class="priority-list">${priorities
          .map(
            (p) =>
              `<li class="priority-row signal-${p.signal}"><div class="pkg-name">${e(p.name)}</div><div class="reason">${e(p.reason)}</div>${reportCommand(priorityCommand(p, commands))}</li>`,
          )
          .join('')}</ol>`
      : `<p class="more">Nothing urgent: no advisories, deprecations, unsupported lines or blocking peers.</p>${
          report.cheapBatch?.length
            ? `<ol class="priority-list"><li class="priority-row"><div class="pkg-name">Cheap batch</div><div class="reason">${e(cheapBatchLabel(report.cheapBatch, 8))}: minor/patch, few files, one PR</div>${reportCommand(cheapBatchCommand(report.cheapBatch, commands))}</li></ol>`
            : ''
        }`;
    return `<section class="priorities">${sectionLabel(nextSection(), 'Priorities', `Most urgent first · ${advisoryStatus(report)}`)}${rows}</section>`;
  };
  const repo = opts.header?.repo ?? basename(report.repo);
  const count = (change: ListedDependency['change']): number =>
    report.packages.filter((p) => p.change === change).length;
  return reportDocument(
    `Uptide list · ${repo}`,
    `${reportHeader({ kind: 'list', repo, manager: opts.header?.manager ?? 'Package manager unavailable', ...opts })}${reportStats(
      [
        { label: 'Outdated', value: report.packages.length, filter: 'all' },
        ...(report.unknown?.length
          ? [{ label: 'Unknown', value: report.unknown.length, tone: 'warn' as const }]
          : []),
        { label: 'Major', value: count('major'), tone: 'warn', filter: 'major' },
        { label: 'Minor', value: count('minor'), filter: 'minor' },
        { label: 'Patch', value: count('patch'), filter: 'patch' },
        { label: 'Groups', value: groups.length, filter: 'groups' },
        { label: 'Tooling', value: tooling.length, filter: 'tooling' },
        {
          label: 'Priority',
          value: report.packages.filter((p) => urgent.has(p.name)).length,
          tone: priorities.length ? 'warn' : 'safe',
          filter: 'priority',
        },
        {
          label: 'Verified',
          value: report.packages.filter((p) => p.tier === 'verified').length,
          filter: 'verified',
        },
        { label: 'Possibly unused', value: unused.length, filter: 'unused' },
      ],
    )}
<div class="filter-status" role="status" hidden><span data-filter-label></span><button type="button" data-filter-clear>Clear</button></div>
<p class="more" data-filter-empty hidden>No packages match this filter.</p>
<div data-list>
${priorityBlock()}
${(report.scanWarnings ?? []).map((warning) => `<p class="more">${e(warning)}</p>`).join('')}
${report.unknown?.length ? `<p class="more">${report.unknown.length} ${e(notCheckedLabel(report))}. Latest versions are unknown.</p>` : ''}
${groups.length ? `<div data-block>${sectionLabel(nextSection(), 'Groups', 'Upgrade together')}${groups.map((g) => group(g, 'group')).join('')}</div>` : ''}
${used.length ? `<div data-block>${sectionLabel(nextSection(), 'Packages')}<section class="package">${used.map((p) => standalone(p, 'used')).join('')}</section></div>` : ''}
${collapsed('Tooling', tooling, 'tooling')}${collapsed('Possibly unused', unused, 'unused')}
</div>
${report.skipped?.length ? `<details class="notes"><summary>${nextSection()} / Not checked / ${report.skipped.length} non-registry source${report.skipped.length === 1 ? '' : 's'}</summary>${report.skipped.map((p) => `<div class="source-row"><strong>${e(p.name)}</strong><span class="label">Skipped</span><span>${e(p.reason)}</span></div>`).join('')}</details>` : ''}
${!report.packages.length && !report.failures.length && !report.unknown?.length && !report.skipped?.length ? '<p class="more safe">Every direct dependency is up to date.</p>' : ''}
${failures.length ? `<section class="notes">${sectionLabel(nextSection(), 'Incomplete discovery')}${failures.map((f) => `<div class="incomplete-row"><strong>${e(f.name)}</strong><span class="label">${report.unknown?.some((p) => p.name === f.name) ? 'Unknown' : 'Incomplete'}</span><span>${opts.details || f.kind === 'registry' ? e(f.reason) : 'metadata or current version unavailable; see terminal output'}</span></div>`).join('')}</section>` : ''}
<footer>Usage is a syntax scan, no type analysis. Generic analysis is the default; verified means a migration pack is available.<br>Local report · No network requests · ${opts.details ? 'File lists included. No source code.' : 'No source code or file paths. Run commands from the named repository; --details adds file lists.'}</footer>`,
  );
}
export function writeListHtml(
  report: ListReport,
  opts: ListHtmlOptions,
  path: string | true,
  cwd: string,
): string {
  return writeReportHtml(
    renderListHtml(report, opts),
    opts.header?.repo ?? basename(report.repo),
    'list',
    path,
    cwd,
  );
}
