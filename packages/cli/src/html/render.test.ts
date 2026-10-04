import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { CheckReport } from '@uptide/core';
import { describe, expect, it } from 'vitest';
import { tempRepo } from '../test-utils.js';
import { css, js } from './assets.js';
import { excerptReader } from './excerpts.js';
import { type HtmlOptions, MAX_HTML_BYTES, renderHtml } from './render.js';

const fixture = (name: string): CheckReport => {
  const path =
    name === 'zod' ? '../__fixtures__/storefront-check.json' : `../__fixtures__/html/${name}.json`;
  const report = JSON.parse(readFileSync(join(import.meta.dirname, path), 'utf8')) as CheckReport;
  if (name === 'zod') report.packages = report.packages.filter((p) => p.name === 'zod');
  return report;
};
const opts: HtmlOptions = {
  root: '/repo',
  date: '2026-10-02T12:00:00Z',
  version: '0.1.0',
  timeZone: 'America/Los_Angeles',
  header: { repo: 'demo', manager: 'pnpm', packages: 6, ms: 25000 },
  fixable: ['zod', 'stripe'],
  repeat: { cwd: '/repo' },
};
/** Snapshot semantic structure, leaving CSS/JS free to evolve. */
function structure(html: string): string {
  return html
    .replace(/<style>[\s\S]*?<\/style>|<script>[\s\S]*?<\/script>/g, '')
    .replace(/<article class="site">[\s\S]*?<\/article>/g, '[site]')
    .replace(/<head>[\s\S]*?<\/head>/, '')
    .replace(/>\s*</g, '>\n<');
}
describe('HTML report', () => {
  it.each(['zod', 'stripe', 'clean', 'skipped'])(
    'renders %s from report JSON without requiring JS',
    (name) => {
      const html = renderHtml(fixture(name), opts);
      expect(structure(html)).toMatchSnapshot();
      expect(Buffer.byteLength(html)).toBeLessThan(MAX_HTML_BYTES);
      expect(html).not.toMatch(/<(?:img|iframe|link)\b|<[^>]+\bsrc=/i);
      expect(css).not.toMatch(/@import|url\(/i);
      expect(html).toContain(
        `script-src 'sha256-${createHash('sha256').update(js).digest('base64')}'`,
      );
      expect(html).toContain("connect-src 'none'");
      expect(html).toContain('class="filters" hidden');
      expect(html).toContain('@media print');
      if (name === 'stripe') expect(html).toContain('compiler message');
    },
  );
  it('summarizes the verdict, merges deprecated formats without changing core labels, and deduplicates compiler text', () => {
    const report = JSON.parse(
      readFileSync(join(import.meta.dirname, '../__fixtures__/storefront-check.json'), 'utf8'),
    ) as CheckReport;
    const before = JSON.stringify(report);
    const html = renderHtml(report, opts);
    expect(html).toContain(
      '32 breaking changes in 10 files. 25 fixable by rule, 7 by agent. 15 deprecated calls (not blocking).',
    );
    expect(html).toContain('13 sites · 8 by rule · 5 by agent');
    expect(html.match(/Top-level string formats/g)).toHaveLength(1);
    expect(html.match(/New error API/g)).toHaveLength(1);
    expect(html).not.toContain('low-confidence');
    expect(
      html.match(/1 type error that already existed before the upgrade was ignored\./g),
    ).toHaveLength(1);
    expect(html).toContain('npx uptide');
    // The tier of every dependency, and the difference in one line.
    expect(html).toContain('3.25.76 → 4.6.5 · major · verified');
    expect(html).toContain('3.2.4 → 5.0.3 · major · generic');
    expect(html.match(/verified: migration pack · generic: no pack/g)).toHaveLength(1);
    expect(html).toContain('Oct 2, 2026');
    expect(html).toContain('5:00 AM PDT');
    expect(html).toContain('Uptide CLI 0.1.0');
    expect(html).toContain('Use `z.core.$ZodIssue`');
    expect(html).toContain('Use the `z.treeifyError(err)` function instead.');
    expect(html).not.toContain('migrate the listed calls when convenient');
    expect(html).toContain('1 API change since 2023-10-16 affects your code');
    const compiler = report.packages.flatMap((p) => p.findings).find((f) => f.usage.compileError)
      ?.usage.compileError;
    expect(compiler).toBeTruthy();
    const escaped = String(compiler)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
    expect(html.split(escaped)).toHaveLength(2);
    expect(JSON.stringify(report)).toBe(before);
  });
  it('escapes malicious repo names, file names, reasons and code, including closing script tags', () => {
    const report = fixture('stripe');
    const p = report.packages[0];
    assert(p);
    const g = p.plan?.[0];
    assert(g);
    const attack = '</script><img onerror=alert(1)>"&';
    assert(g.locations[0]);
    g.locations[0].file = attack;
    g.title = attack;
    g.detail = attack;
    p.notes = [attack];
    const html = renderHtml(report, {
      ...opts,
      header: { ...(opts.header as NonNullable<HtmlOptions['header']>), repo: attack },
      readExcerpt: () => ({ lines: [{ number: 67, text: attack }] }),
    });
    expect(html).not.toContain(attack);
    expect(html).toContain('&lt;/script&gt;&lt;img onerror=alert(1)&gt;&quot;&amp;');
    expect(html.match(/<script>/g)).toHaveLength(1);
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(html).not.toContain('<img');
  });
  it('caps excerpts at 50 per group but retains additional sites within the size budget', () => {
    const report = fixture('zod');
    const g = report.packages[0]?.plan?.[0];
    assert(g);
    g.locations = Array.from({ length: 250 }, (_, i) => ({ file: `src/${i}.ts`, line: 4 }));
    const html = renderHtml(report, {
      ...opts,
      readExcerpt: () => ({
        lines: Array.from({ length: 7 }, (_, i) => ({ number: i + 1, text: '<'.repeat(240) })),
      }),
    });
    expect(html).toContain('and 200 more sites');
    expect(Buffer.byteLength(html)).toBeLessThan(MAX_HTML_BYTES);
    expect(html).toContain('src/50.ts');
    expect(html).toContain('excerpts omitted');
  });
  it('reads only ±3 lines and refuses traversal, escaping symlinks and invalid lines', () => {
    const root = tempRepo({
      'code.ts': Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n'),
    });
    const outside = tempRepo({ secret: 'DO NOT INCLUDE' });
    try {
      symlinkSync(join(outside, 'secret'), join(root, 'link.ts'));
      const read = excerptReader(root);
      expect(read('code.ts', 6).lines.map((l) => l.number)).toEqual([3, 4, 5, 6, 7, 8, 9]);
      for (const path of ['../secret', join(outside, 'secret'), 'link.ts'])
        expect(read(path, 1).lines).toEqual([]);
      expect(read('code.ts', 0).lines).toEqual([]);
      expect(read('code.ts', 999).lines).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
  it('quotes the exact next commands for paths with spaces and shell metacharacters', () => {
    const html = renderHtml(fixture('stripe'), {
      ...opts,
      repeat: { cwd: '/repo/my app; echo BAD', targets: { stripe: '22.6.2' } },
    });
    expect(html).toContain('--target 22.6.2 --cwd &#39;/repo/my app; echo BAD&#39;');
  });
});
