import { createHash } from 'node:crypto';
import { css, js } from './assets.js';
import { escapeHtml } from './escape.js';

/** Shared local-report shell, styling, copy buttons and print behavior. */
export function reportDocument(title: string, body: string): string {
  const scriptHash = createHash('sha256').update(js).digest('base64');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${scriptHash}'; connect-src 'none'; base-uri 'none'; form-action 'none'"><meta name="referrer" content="no-referrer"><title>${escapeHtml(title)}</title><style>${css}</style></head>
<body><main>${body}</main><script>${js}</script></body></html>`;
}

export interface ReportHeader {
  kind: 'list' | 'check';
  repo: string;
  manager: string;
  date: string;
  version: string;
  timeZone?: string;
}
const logo =
  '<svg viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M3 23c4.5 0 6.8-2.6 8.6-6.4C13.6 12.2 16.2 8 21.2 8c3.9 0 6.8 2.6 6.8 5.8 0 2.4-1.8 4.1-4.1 4.1-1.9 0-3.1-1.2-3.1-2.8" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 27.5h26" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>';
export function reportHeader(opts: ReportHeader): string {
  const e = escapeHtml;
  const when = new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
    timeZone: opts.timeZone,
  }).format(new Date(opts.date));
  return `<header class="hero dots"><div class="report-top"><div class="brand">${logo}<span>uptide</span></div><span class="label">Dependency ${opts.kind === 'list' ? 'discovery' : 'check'} / local report</span></div><div class="label">${opts.kind === 'list' ? 'Your dependencies, at a glance' : 'Your upgrade, before you merge'}</div><h1>${e(opts.repo)}</h1><div class="meta"><span>${e(opts.manager)}</span><time datetime="${e(opts.date)}">Generated ${e(when)}</time><span>Uptide CLI ${e(opts.version)}</span></div></header>`;
}
export function reportStats(
  stats: { label: string; value: number; tone?: 'warn' | 'safe' }[],
): string {
  return `<div class="stats" style="--stat-count:${stats.length}">${stats.map((s) => `<div class="stat ${s.tone ?? ''}"><strong>${s.value}</strong><span class="label">${escapeHtml(s.label)}</span></div>`).join('')}</div>`;
}
export const reportCommand = (command: string): string =>
  `<div class="term command"><code>${escapeHtml(command)}</code><button type="button" class="copy" data-copy hidden aria-label="Copy command">Copy</button></div>`;
export const sectionLabel = (number: string, label: string, subtitle = ''): string =>
  `<div class="section-label"><h2>${number} / ${escapeHtml(label)}</h2>${subtitle ? `<p>${escapeHtml(subtitle)}</p>` : ''}</div>`;
