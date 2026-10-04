import { basename } from 'node:path';
import type { ListedDependency, ListGroup, ListReport } from '@uptide/core';
import {
  type FormatListOptions,
  groupCommand,
  groupVersions,
  listBlocks,
  listChange,
  listCommand,
  listSections,
  listSymbols,
  listUsage,
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
export function renderListHtml(report: ListReport, opts: ListHtmlOptions): string {
  const { groups, used, tooling, unused } = listSections(report);
  const failures = [...new Map(report.failures.map((f) => [f.name, f])).values()];
  let section = 0;
  const nextSection = (): string => String(++section).padStart(2, '0');
  const commands = { ...opts, cwd: opts.details ? opts.cwd : undefined };
  const row = (p: ListedDependency, command?: string): string =>
    `<article class="member-grid${command ? ' has-command' : ''}"><div class="pkg-name">${e(p.name)}${p.tier === 'verified' ? '<span class="verified">verified</span>' : ''}</div><div class="versions">${e(p.current)} → ${e(p.latest)}</div><div class="gap">${e(listChange(p))}</div><div class="usage${p.peerOf ? ' muted' : ''}">${p.peerOf ? `peer of ${e(p.peerOf.join(', '))}` : e(listUsage(p))}</div>${command ? reportCopyButton(command) : ''}${(p.classification === 'tooling' || p.classification === 'possibly-unused') && p.reasons.length ? `<div class="details-line">${p.reasons.map(e).join(' · ')}</div>` : ''}${opts.details && listSymbols(p) ? `<div class="details-line">Top symbols: ${e(listSymbols(p))}</div>` : ''}${opts.details && p.usage.fileList?.length ? `<details class="details-line"><summary>Files</summary><ul>${p.usage.fileList.map((file) => `<li>${e(file)}</li>`).join('')}</ul></details>` : ''}</article>`;
  const group = (g: ListGroup): string =>
    `<section class="package"><header><h2>${e(g.name)}</h2><div class="meta"><span>${g.members.length} packages</span><span>${e(groupVersions(g))}</span></div>${reportCommand(groupCommand(g, commands))}</header>${g.members.map((p) => row(p)).join('')}</section>`;
  const standalone = (p: ListedDependency): string => row(p, listCommand([p], commands));
  const collapsed = (label: string, packages: ListedDependency[]): string =>
    packages.length
      ? `<details class="notes"><summary>${nextSection()} / ${label} / ${packages.length} package${packages.length === 1 ? '' : 's'}</summary>${label === 'Possibly unused' ? `<p class="more">${e(UNUSED_HINT)}</p>` : ''}${listBlocks(
          packages,
          report,
        )
          .map((block) =>
            block.name ? group(block as ListGroup) : block.members.map(standalone).join(''),
          )
          .join('')}</details>`
      : '';
  const repo = opts.header?.repo ?? basename(report.repo);
  return reportDocument(
    `Uptide list · ${repo}`,
    `${reportHeader({ kind: 'list', repo, manager: opts.header?.manager ?? 'Package manager unavailable', ...opts })}${reportStats(
      [
        { label: 'Outdated', value: report.packages.length },
        ...(report.unknown?.length
          ? [{ label: 'Unknown', value: report.unknown.length, tone: 'warn' as const }]
          : []),
        {
          label: 'Major',
          value: report.packages.filter((p) => p.change === 'major').length,
          tone: 'warn',
        },
        { label: 'Minor', value: report.packages.filter((p) => p.change === 'minor').length },
        { label: 'Groups', value: groups.length },
        { label: 'Tooling', value: tooling.length },
      ],
    )}
${report.unknown?.length ? `<p class="more">${report.unknown.length} not checked (network). Latest versions are unknown.</p>` : ''}
${groups.length ? sectionLabel(nextSection(), 'Groups', 'Upgrade together') + groups.map(group).join('') : ''}
${used.length ? `${sectionLabel(nextSection(), 'Packages')}<section class="package">${used.map(standalone).join('')}</section>` : ''}
${collapsed('Tooling', tooling)}${collapsed('Possibly unused', unused)}
${!report.packages.length && !report.failures.length && !report.unknown?.length ? '<p class="more safe">Every direct dependency is up to date.</p>' : ''}
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
