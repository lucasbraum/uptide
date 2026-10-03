import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type FixReport, migrationBody, summaryCells } from '@uptide/core';
import { elapsed } from '../progress.js';
import { css } from './assets.js';
import { escapeHtml } from './render.js';

export interface MigrationHtmlOptions {
  version: string;
  date: string;
  timeZone?: string;
}

/**
 * The migration report as a page: the same shell, styles and policy as the check report
 * (no network, inline styles only, no script), with the PR body rendered. The body is a
 * small Markdown: headings, paragraphs, bullet lists, two-column tables, fenced code,
 * `<details>` blocks, and inline code, bold and links. That is all `markdownToHtml` renders;
 * everything else is text, so nothing the repository wrote runs in the page.
 */
export function renderMigrationHtml(report: FixReport, opts: MigrationHtmlOptions): string {
  const e = escapeHtml;
  // The whole report: the PR description is the part of it that fits GitHub's limit.
  const body = migrationBody(report);
  const title = body.split('\n')[0]?.replace(/^#+\s*/, '') ?? 'Migration report';
  const cells = summaryCells(report);
  const verdict = report.verification.passed ? 'verification passed' : 'verification failed';
  const when = new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
    timeZone: opts.timeZone,
  }).format(new Date(opts.date));
  const scriptHash = createHash('sha256').update('').digest('base64');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${scriptHash}'; connect-src 'none'; base-uri 'none'; form-action 'none'"><meta name="referrer" content="no-referrer"><title>Uptide fix · ${e(title)}</title><style>${css}
.summary table{width:100%;border-collapse:collapse}.summary td{padding:10px 20px;border-bottom:1px solid var(--border);vertical-align:top}.summary tr:last-child td{border-bottom:0}.summary td:first-child{width:140px;font-weight:700}.body h2{display:none}.body h3{font-size:18px;margin:28px 0 12px}.body table{border-collapse:collapse;margin:12px 0}.body td{border:1px solid var(--border);padding:6px 12px}.body details{border:1px solid var(--border);border-radius:8px;margin:12px 0}.body pre{white-space:pre-wrap;overflow-wrap:anywhere;padding:12px}.diff-add{color:var(--green)}.diff-del{color:var(--red)}</style></head>
<body><main><header><div class="brand">UPTIDE / FIX</div><h1>${e(title)}</h1><div class="meta"><span>${e(verdict)}</span><span>branch ${e(report.branch)}</span><time datetime="${e(opts.date)}">${e(when)}</time><span>Uptide CLI ${e(opts.version)}</span><span>${e(elapsed(report.timingMs))}</span></div></header>
<section class="summary"><table>${(
    [
      ['Risk', cells.risk],
      ['Changes', cells.changes],
      ['Types', cells.types],
      ['Behavior', cells.behavior],
      ['Tests', cells.tests],
    ] as const
  )
    .map(([label, text]) => `<tr><td>${label}</td><td>${inline(text)}</td></tr>`)
    .join('')}</table></section>
<section class="body">${markdownToHtml(body)}</section>
<footer>Local report · No network requests · Rendered from the stored run's PR description. Review before sharing.</footer></main></body></html>
`;
}

/**
 * Written next to the stored run (`pr-body.md`), as `report.html`; the stored run, when it is
 * there, learns the path so a later `uptide pr` or `verify` finds it. Returns the path.
 */
export function writeMigrationHtml(report: FixReport, opts: MigrationHtmlOptions): string {
  const dir = dirname(report.prBody);
  const path = join(dir, 'report.html');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, renderMigrationHtml(report, opts), { mode: 0o600 });
  const stored = join(dir, 'report.json');
  if (existsSync(stored)) {
    try {
      const saved = JSON.parse(readFileSync(stored, 'utf8')) as FixReport;
      writeFileSync(stored, JSON.stringify({ ...saved, html: path }, null, 2));
    } catch {
      // The page is there; the pointer is a convenience.
    }
  }
  return path;
}

/** Inline code, bold and links; everything else is text. */
function inline(text: string): string {
  const parts: string[] = [];
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  let last = 0;
  for (const m of text.matchAll(pattern)) {
    parts.push(escapeHtml(text.slice(last, m.index)));
    if (m[1] !== undefined) parts.push(`<code>${escapeHtml(m[1])}</code>`);
    else if (m[2] !== undefined) parts.push(`<strong>${inline(m[2])}</strong>`);
    else parts.push(`<a href="${escapeHtml(m[4] as string)}">${inline(m[3] as string)}</a>`);
    last = (m.index ?? 0) + m[0].length;
  }
  parts.push(escapeHtml(text.slice(last)));
  return parts.join('');
}

export function markdownToHtml(markdown: string): string {
  const lines = markdown.split('\n');
  const out: string[] = [];
  let i = 0;
  let list = false;
  const closeList = (): void => {
    if (list) out.push('</ul>');
    list = false;
  };
  while (i < lines.length) {
    const line = lines[i] as string;
    if (line.startsWith('```')) {
      closeList();
      const lang = line.slice(3).trim();
      const body: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] as string).startsWith('```')) {
        body.push(lines[i] as string);
        i++;
      }
      i++;
      const rendered =
        lang === 'diff'
          ? body
              .map((l) =>
                l.startsWith('+') && !l.startsWith('+++')
                  ? `<span class="diff-add">${escapeHtml(l)}</span>`
                  : l.startsWith('-') && !l.startsWith('---')
                    ? `<span class="diff-del">${escapeHtml(l)}</span>`
                    : escapeHtml(l),
              )
              .join('\n')
          : escapeHtml(body.join('\n'));
      out.push(`<pre><code>${rendered}</code></pre>`);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      closeList();
      const level = (heading[1] as string).length;
      out.push(`<h${level}>${inline(heading[2] as string)}</h${level}>`);
      i++;
      continue;
    }
    if (/^(?:<details>)?(?:<summary>|<\/details>)|^<details>$/.test(line)) {
      closeList();
      // `<details>` and `<summary>` are the only tags the body writes; their text is inlined.
      out.push(
        line.replace(
          /<summary>(.*)<\/summary>/,
          (_, t: string) => `<summary>${inline(t)}</summary>`,
        ),
      );
      i++;
      continue;
    }
    if (line.startsWith('|')) {
      closeList();
      const rows: string[] = [];
      while (i < lines.length && (lines[i] as string).startsWith('|')) {
        const row = lines[i] as string;
        i++;
        if (/^\|[\s-|]*\|$/.test(row)) continue;
        const cells = row.slice(1, row.endsWith('|') ? -1 : undefined).split('|');
        rows.push(`<tr>${cells.map((c) => `<td>${inline(c.trim())}</td>`).join('')}</tr>`);
      }
      out.push(`<table>${rows.join('')}</table>`);
      continue;
    }
    if (/^- /.test(line)) {
      if (!list) out.push('<ul>');
      list = true;
      out.push(`<li>${inline(line.slice(2))}</li>`);
      i++;
      continue;
    }
    if (line.trim() === '') {
      closeList();
      i++;
      continue;
    }
    if (line === '---') {
      closeList();
      out.push('<hr>');
      i++;
      continue;
    }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
    i++;
  }
  closeList();
  return out.join('\n');
}
