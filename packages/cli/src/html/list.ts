import { basename } from 'node:path';
import type { ListedDependency, ListReport } from '@uptide/core';
import {
  type FormatListOptions,
  listBlocks,
  listChange,
  listCommand,
  listSections,
  listSymbols,
  listUsage,
} from '../format-list.js';
import { escapeHtml as e } from './escape.js';
import { reportDocument } from './template.js';
import { writeReportHtml } from './write.js';

export interface ListHtmlOptions extends FormatListOptions {
  version: string;
  date: string;
  timeZone?: string;
}

export function renderListHtml(report: ListReport, opts: ListHtmlOptions): string {
  const { groups, used, tooling, unused } = listSections(report);
  // A shareable report includes no local paths unless details were explicitly requested.
  const command = (members: ListedDependency[]): string =>
    `<div class="command"><code>${e(listCommand(members, { ...opts, cwd: opts.details ? opts.cwd : undefined }))}</code><button type="button" data-copy hidden aria-label="Copy command">Copy</button></div>`;
  const row = (p: ListedDependency, members = [p]): string =>
    `<article class="site"><h3>${e(p.name)}</h3><p class="mono muted">${e(p.current)} → ${e(p.latest)} · ${e(listChange(p))} · ${e(p.tier)}</p><p>${e(listUsage(p))}${p.usage.references && !p.usage.callSites ? ` · ${p.usage.references} reference${p.usage.references === 1 ? '' : 's'}` : ''}</p>${listSymbols(p) ? `<p class="muted">Top symbols: ${e(listSymbols(p))}</p>` : ''}${p.classification === 'tooling' ? `<p class="muted">Tooling: ${e(p.reasons.join('; '))}</p>` : ''}${opts.details && p.usage.fileList?.length ? `<details><summary>Files</summary><ul>${p.usage.fileList.map((file) => `<li>${e(file)}</li>`).join('')}</ul></details>` : ''}${command(members)}</article>`;
  const groupRows = groups
    .map(
      (g) =>
        `<section class="package"><header><h2>${e(g.name)}</h2><p class="muted">${g.members.length} packages · check together</p>${command(g.members)}</header>${g.members.map((p) => row(p, g.members)).join('')}</section>`,
    )
    .join('');
  const collapsed = (label: string, packages: ListedDependency[]): string =>
    packages.length
      ? `<details class="notes"><summary>${label} · ${packages.length} package${packages.length === 1 ? '' : 's'}</summary>${listBlocks(
          packages,
          report,
        )
          .map(
            (block) =>
              `${block.name ? `<header class="site"><h3>${e(block.name)}</h3><p class="muted">Check together</p>${command(block.members)}</header>` : ''}${block.members.map((p) => row(p, block.members)).join('')}`,
          )
          .join('')}</details>`
      : '';
  const counts = ['major', 'minor', 'patch']
    .map((change) => `${report.packages.filter((p) => p.change === change).length} ${change}`)
    .join(' · ');
  const when = new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
    timeZone: opts.timeZone,
  }).format(new Date(opts.date));
  const repo = opts.header?.repo ?? basename(report.repo);
  return reportDocument(
    `Uptide list · ${repo}`,
    `<header><div class="brand">UPTIDE / LIST</div><h1>${e(repo)}</h1><div class="meta"><span>${e(opts.header?.manager ?? 'Package manager unavailable')}</span><span>${e(counts)}</span><time datetime="${e(opts.date)}">Generated ${e(when)}</time><span>Uptide CLI ${e(opts.version)}</span></div><p class="muted">${report.packages.length} outdated dependencies · ${report.groups.length} groups</p></header>
${groupRows}${used.length ? `<section class="package"><header><h2>Packages</h2></header>${used.map((p) => row(p)).join('')}</section>` : ''}${collapsed('Tooling', tooling)}${collapsed('Possibly unused', unused)}
${!report.packages.length && !report.failures.length ? '<p class="more safe">Every direct dependency is up to date.</p>' : ''}
${report.failures.length ? `<section class="notes"><h2>Incomplete discovery</h2>${report.failures.map((f) => `<p class="more">${e(f.name)}: ${opts.details ? e(f.reason) : 'metadata or current version unavailable; see terminal output'}</p>`).join('')}</section>` : ''}
<footer>Local report · No network requests · Usage is a syntax scan of calls and references through imported bindings; no type analysis. ${opts.details ? 'File lists included.' : 'No source code or file paths included. Use --details for file lists.'}</footer>`,
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
