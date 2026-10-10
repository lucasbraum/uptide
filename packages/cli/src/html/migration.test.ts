import type { FixReport } from '@uptide/core';
import { expect, it } from 'vitest';
import { markdownToHtml, renderMigrationHtml } from './migration.js';

it("renders the PR body's own Markdown and escapes everything else", () => {
  const html = markdownToHtml(
    [
      '## Upgrade zod 3 → 4',
      '',
      '**Ready.** See [docs](https://example.test/a) and `code` <script>alert(1)</script>.',
      '',
      '| | |',
      '|---|---|',
      '| **Risk** | Low |',
      '',
      '- one',
      '- two `x`',
      '',
      '<details><summary>Diff and `reasoning`</summary>',
      '',
      '```diff',
      '-old',
      '+new',
      '```',
      '',
      '</details>',
    ].join('\n'),
  );
  expect(html).toContain('<h2>Upgrade zod 3 → 4</h2>');
  expect(html).toContain(
    '<strong>Ready.</strong> See <a href="https://example.test/a">docs</a> and <code>code</code> &lt;script&gt;alert(1)&lt;/script&gt;.',
  );
  expect(html).toContain('<table><tr><td><strong>Risk</strong></td><td>Low</td></tr></table>');
  expect(html).toContain('<ul>\n<li>one</li>\n<li>two <code>x</code></li>\n</ul>');
  expect(html).toContain('<details><summary>Diff and <code>reasoning</code></summary>');
  expect(html).toContain('<span class="diff-del">-old</span>\n<span class="diff-add">+new</span>');
});

it('is a complete page titled by the run', () => {
  const report = {
    repo: '/r',
    package: 'zod',
    from: '3.25.76',
    target: '4.6.5',
    branch: 'uptide/zod-4.6.5',
    sites: [],
    verification: {
      baseline: [],
      target: [],
      after: [],
      newErrors: [],
      baselineTests: [],
      tests: [],
      passed: true,
    },
    llm: { inputTokens: 0, outputTokens: 0, costUsd: 0, available: false },
    timingMs: 1,
    prBody: '/r/pr-body.md',
    notes: [],
  } as FixReport;
  const page = renderMigrationHtml(report, {
    version: '0.2.0',
    date: '2026-10-02T12:00:00.000Z',
    timeZone: 'UTC',
  });
  expect(page.startsWith('<!doctype html>')).toBe(true);
  expect(page).toContain('<title>Uptide fix · Upgrade zod 3.25.76 → 4.6.5</title>');
  expect(page).toContain('<h1>Upgrade zod 3.25.76 → 4.6.5</h1>');
  expect(page).toContain('<td>Risk</td>');
  expect(page).toContain('Content-Security-Policy');
  expect(page).not.toContain('<script');
});

it('renders accepted lockfile housekeeping collapsed in the fix report', async () => {
  const { fixReport } = await import('../test-utils.js');
  const report = fixReport(true);
  report.lockfile = {
    manager: 'npm',
    file: 'package-lock.json',
    added: [],
    removed: [],
    changed: [],
    allowed: [],
    housekeeping: {
      deduped: [
        {
          from: 'node_modules/a/node_modules/b',
          to: 'node_modules/b',
          name: 'b',
          version: '1.0.0',
        },
      ],
      metadata: ['node_modules/c'],
    },
  };
  const page = renderMigrationHtml(report, {
    version: '1.0.0',
    date: '2026-10-10T12:00:00.000Z',
    timeZone: 'UTC',
  });
  expect(page).toContain(
    '<details><summary>Lockfile housekeeping · 1 dedupe move · 1 metadata-only change</summary>',
  );
  expect(page).toContain('<code>node_modules/a/node_modules/b</code>');
  expect(page).not.toContain('<details open');
});
