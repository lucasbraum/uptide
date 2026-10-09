import { basename } from 'node:path';
import { type CheckReport, isFailure, type PackageReport, type PlanGroup } from '@uptide/core';
import { byLine, checkRows, type FormatCheckOptions, nextCommands } from '../format-check.js';
import { groupReason, groupsForHtml, notesOf, stripeNote, verdict } from './content.js';
import { escapeHtml } from './escape.js';
import { localFile, type ReadExcerpt } from './excerpts.js';
import {
  reportCommand,
  reportDocument,
  reportHeader,
  reportStats,
  sectionLabel,
} from './template.js';

export { escapeHtml } from './escape.js';

export const MAX_HTML_BYTES = 300_000;
const short = (s: string, limit = 1200) =>
  s.length > limit ? `${s.slice(0, limit)}… [truncated]` : s;
export interface HtmlOptions extends FormatCheckOptions {
  root: string;
  version: string;
  date: string;
  readExcerpt?: ReadExcerpt;
  timeZone?: string;
}
function compilerAt(p: PackageReport, group: PlanGroup, file: string, line: number): string {
  const matches = p.findings.filter(
    (f) =>
      f.severity === group.severity &&
      ((f.usage.file === file &&
        (f.usage.line === line || f.sites?.some((s) => s.line === line))) ||
        f.downstream?.some((s) => s.file === file && s.line === line)),
  );
  return (
    [
      ...new Set(
        matches.flatMap((f) => {
          const downstream = f.downstream?.find((s) => s.file === file && s.line === line);
          return downstream
            ? [downstream.message]
            : f.usage.compileError
              ? [f.usage.compileError]
              : [];
        }),
      ),
    ].join(' · ') || (group.severity !== 'deprecated' ? group.detail : '')
  );
}
/**
 * Under a parameter anchor: `N call sites`, then where (the first few). The anchor is the one
 * edit; the call sites, in whatever workspace, are its evidence.
 */
function callSitesAt(
  p: PackageReport,
  file: string,
  line: number,
): ((e: (s: unknown) => string) => string) | undefined {
  const anchor = p.findings.find(
    (f) =>
      f.change.kind === 'cause' &&
      f.callSites !== undefined &&
      f.usage.file === file &&
      f.usage.line === line,
  );
  if (!anchor?.callSites) return undefined;
  const sites = anchor.downstream ?? [];
  const shown = sites.slice(0, CALL_SITES_SHOWN);
  return (e) =>
    `<p class="muted call-sites">${e(anchor.callSites)} ${anchor.callSites === 1 ? 'call site' : 'call sites'}</p><ul class="mono call-sites">${shown.map((s) => `<li>${e(`${s.file}:${s.line}`)} <span class="muted">TS${e(s.code)}</span></li>`).join('')}${sites.length > shown.length ? `<li class="muted">and ${e(sites.length - shown.length)} more</li>` : ''}</ul>`;
}
const CALL_SITES_SHOWN = 10;

/** No repo data is interpolated into executable JS, CSS, attribute names or element names. */
export function renderHtml(report: CheckReport, opts: HtmlOptions): string {
  function render(
    excerptBudget: number,
    siteLimit: number,
    groupLimit: number,
    compact: boolean,
  ): string {
    const e = (s: unknown) => escapeHtml(short(String(s), compact ? 300 : 1600));
    const rows = checkRows(report).map((r) => ({
      ...r,
      name: opts.details ? r.name : r.p.name,
      plan: groupsForHtml(r.p, r.plan),
    }));
    const messages = new Map<string, string>();
    let groupsLeft = groupLimit;
    function group(p: PackageReport, g: PlanGroup): string {
      if (groupsLeft-- <= 0) return '';
      if (!opts.details)
        return `<details class="group" data-severity="${e(g.severity)}" data-rule="${e(g.rule)}"><summary><strong class="${e(g.severity)}">${e(g.title)}</strong><span class="counts">${g.sites} ${g.sites === 1 ? 'site' : 'sites'} · ${e(byLine([g]))}</span></summary><p class="more">Run check --html --details for locations, source excerpts and compiler messages.</p></details>`;
      let body = '',
        overflow = '';
      for (const [index, site] of (compact
        ? g.locations.slice(0, siteLimit)
        : g.locations
      ).entries()) {
        const absolute = localFile(opts.root, site.file);
        const label = `${site.file}:${site.line}`;
        const link =
          absolute && Number.isSafeInteger(site.line) && site.line > 0
            ? `<a href="${escapeHtml(`vscode://file/${absolute.replaceAll('\\', '/').replace(/^\//, '').split('/').map(encodeURIComponent).join('/')}:${site.line}`)}">${e(label)}</a>`
            : e(label);
        let excerpt = '';
        if (index < siteLimit && excerptBudget > 0 && opts.readExcerpt) {
          const result = opts.readExcerpt(site.file, site.line);
          if (result.lines.length) {
            const code = result.lines
              .slice(0, 7)
              .map(
                (l) =>
                  `<span class="code-line${l.number === site.line ? ' hit' : ''}"><span class="number">${e(l.number)}</span>${escapeHtml(short(l.text, 240))}</span>`,
              )
              .join('');
            const cost = Buffer.byteLength(code);
            if (cost <= excerptBudget) {
              excerpt = `<pre aria-label="Code excerpt"><code>${code}</code></pre>`;
              excerptBudget -= cost;
            } else excerpt = '<p class="muted">Excerpt omitted to keep this report small.</p>';
          } else
            excerpt = `<p class="muted">${e(result.unavailable ?? 'Excerpt unavailable.')}</p>`;
        }
        const message = compilerAt(p, g, site.file, site.line);
        let compiler = '';
        if (message) {
          const prior = messages.get(message);
          const id = prior ?? `compiler-${messages.size}`;
          messages.set(message, id);
          compiler = prior
            ? `<details class="compiler"><summary>compiler message</summary><a href="#${id}">Same message, shown above</a></details>`
            : `<details class="compiler" id="${id}"><summary>compiler message</summary><pre>${escapeHtml(message)}</pre></details>`;
        }
        const callers = callSitesAt(p, site.file, site.line);
        const article = `<article class="site"><div class="mono">${link}</div>${excerpt}${compiler}${callers ? callers(e) : ''}</article>`;
        if (index < siteLimit) body += article;
        else overflow += article;
      }
      const rest = g.locations.length - Math.min(siteLimit, g.locations.length);
      if (rest > 0)
        body += compact
          ? `<p class="more">and ${rest} more sites — use uptide check &lt;package&gt; --details for every location.</p>`
          : `<details><summary>and ${rest} more sites (excerpts omitted)</summary>${overflow}</details>`;
      if (!g.locations.length)
        body += '<p class="more">No site locations supplied by the engine.</p>';
      return `<details class="group" data-severity="${e(g.severity)}" data-rule="${e(g.rule)}"><summary><strong class="${e(g.severity)}">${e(g.title)}</strong><span class="counts">${g.sites} ${g.sites === 1 ? 'site' : 'sites'} · ${e(byLine([g]))}${g.fixes !== g.sites ? ` · ${g.fixes} ${g.fixes === 1 ? 'fix' : 'fixes'}` : ''}</span><span class="counts">${e(groupReason(g))}</span></summary>${g.note ? `<p class="group-note muted">${e(stripeNote(g.note))}</p>` : ''}${body}</details>`;
    }
    const summary = rows
      .map(
        (r, i) =>
          `<a class="dep" href="#dependency-${i}" data-package="dependency-${i}"><div><strong>${e(r.name)}</strong><span class="mono muted">${e(r.versions)} · ${e(r.bump)}${r.p.tier === 'verified' ? ' · <span class="verified">verified</span>' : ''}</span></div><div class="${r.plan.some((g) => g.severity === 'breaking') ? 'breaking' : r.plan.some((g) => g.severity === 'unverified') || r.p.unanalyzed.length || ['skipped', 'unknown', 'no-types'].includes(r.p.status) ? 'unverified' : r.plan.some((g) => g.severity === 'deprecated') ? 'deprecated' : 'safe'}">${e(r.verdict)}${r.by ? `<div class="muted">${e(r.by)}</div>` : ''}${r.summary ? `<div class="muted">${e(r.summary)}</div>` : ''}</div></a>`,
      )
      .join('');
    const dependencies = rows
      .map((r, i) => {
        const ordinary = r.plan.filter((g) => g.severity !== 'deprecated');
        const deprecated = r.plan.filter((g) => g.severity === 'deprecated');
        return `<section class="package" id="dependency-${i}"><header><h2>${e(r.name)}</h2><span class="mono muted">${e(r.versions)}${r.p.tier === 'verified' ? ' · <span class="verified">verified</span>' : ''}</span>${r.summary ? `<p class="more">${e(r.summary)}</p>` : ''}</header>${ordinary.map((g) => group(r.p, g)).join('')}${deprecated.length ? `<details class="deprecated-section"><summary class="deprecated">Deprecated calls · ${deprecated.reduce((n, g) => n + g.sites, 0)} sites</summary>${deprecated.map((g) => group(r.p, g)).join('')}</details>` : ''}${!r.plan.length ? `<p class="more">${e(r.verdict)}</p>` : ''}</section>`;
      })
      .join('');
    const commands = nextCommands(rows, {
      ...opts,
      invocation: opts.invocation ?? 'npx uptide',
      details: false,
      repeat: { ...opts.repeat, cwd: opts.details ? opts.repeat?.cwd : undefined },
    });
    const notes = opts.details ? notesOf(report) : [];
    // What has no verdict: left out by the time budget, or failed, each with its reason.
    const late = report.packages.filter((p) => p.skipReason === 'TIME_BUDGET');
    const failed = report.packages.filter((p) => isFailure(p));
    const missing =
      late.length + failed.length > 0
        ? `<section class="package" id="not-analyzed"><header><h2>Not analyzed</h2></header>${
            late.length
              ? `<p class="more unverified">${late.length} behind, out of time${opts.maxTime ? ` (--max-time ${e(opts.maxTime)})` : ''}: ${e(late.map((p) => p.name).join(', '))}. Run check with explicit package names.</p>`
              : ''
          }${failed.map((p) => `<p class="more breaking">${e(p.name)} ${e(p.installed)}: ${opts.details ? e((p.notes[0] ?? 'analysis failed').split('\n')[0]) : 'analysis failed; see terminal output'}</p>`).join('')}</section>`
        : '';
    const repo = opts.header?.repo ?? basename(report.repo);
    return reportDocument(
      `Uptide check · ${repo}`,
      `${reportHeader({ kind: 'check', repo, manager: opts.header?.manager ?? 'Package manager unavailable', date: opts.date, version: opts.version, timeZone: opts.timeZone })}${reportStats(
        [
          { label: 'Packages', value: rows.length },
          { label: 'Breaking', value: report.summary.breaking, tone: 'warn' },
          { label: 'Deprecated', value: report.summary.deprecated },
          {
            label: 'Auto-fixable',
            value: rows.reduce(
              (n, r) =>
                n +
                r.plan.filter((g) => g.severity === 'breaking').reduce((m, g) => m + g.by.rule, 0),
              0,
            ),
            tone: 'safe',
          },
          {
            label: 'Need the agent (LLM)',
            value: rows.reduce(
              (n, r) =>
                n +
                r.plan.filter((g) => g.severity === 'breaking').reduce((m, g) => m + g.by.agent, 0),
              0,
            ),
          },
        ],
      )}<p class="more">${e(verdict(rows))}</p>${sectionLabel('01', 'Packages', 'Upgrade impact')}
<div class="filters" hidden role="search" aria-label="Filter findings">${['All', 'Breaking', 'Deprecated', 'Unverified'].map((s) => `<button type="button" data-filter="${s.toLowerCase()}" aria-pressed="${s === 'All'}">${s}</button>`).join('')}<input id="search" type="search" aria-label="Search packages and change rules" placeholder="Search packages or rules…"></div>
<section aria-label="Dependency summary" class="summary">${summary || '<p class="more safe">✓ Nothing to upgrade. No findings in the analyzed scope.</p>'}</section><p id="empty-filter" class="notice" hidden>No findings match these filters.</p>
${compact ? '<p class="notice">Compact report: excerpts and additional sites omitted to stay under 300 KB. Use uptide check &lt;package&gt; --details for the full report.</p>' : ''}${sectionLabel('02', 'Findings', 'What reaches your code')}${dependencies}${missing}
<details class="notes"><summary>Analysis notes · ${notes.length} notes</summary><ul>${
        notes
          .slice(0, compact ? 30 : 300)
          .map((n) => `<li>${e(n)}</li>`)
          .join('') ||
        `<li>${opts.details ? 'No analysis gaps reported.' : 'Use --details for analysis notes, locations and source excerpts.'}</li>`
      }${notes.length > (compact ? 30 : 300) ? '<li>Additional notes omitted; see JSON output.</li>' : ''}</ul></details>
<section class="next"><h2>03 / Next</h2>${commands.map(([cmd, why]) => `<p class="muted">${e(why)}</p>${reportCommand(cmd)}`).join('')}</section>
<footer>Generic analysis is the default; verified means a migration pack is available.<br>Local report · No network requests · ${opts.details ? 'Contains file paths and source excerpts. Review before sharing.' : 'No file paths or source code. Use --details for locations and excerpts.'}</footer>`,
    );
  }
  let html = render(145_000, 50, 1000, false);
  if (Buffer.byteLength(html) >= MAX_HTML_BYTES) html = render(0, 10, 80, true);
  if (Buffer.byteLength(html) >= MAX_HTML_BYTES)
    throw new Error(
      'HTML report exceeds 300 KB even without excerpts; check fewer named packages.',
    );
  return html;
}
