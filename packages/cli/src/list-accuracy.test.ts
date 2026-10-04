import { fileURLToPath } from 'node:url';
import { type ListReport, listDependencies } from '@uptide/core';
import { expect, it } from 'vitest';
import { formatList, UNUSED_HINT } from './format-list.js';
import { renderListHtml } from './html/list.js';

const opts = { version: '0.2.0', date: '2026-10-04T22:00:00Z', timeZone: 'UTC' };
const discover = async () =>
  listDependencies({
    cwd: fileURLToPath(
      new URL('../../../fixtures/repos/list-accuracy/legacy-configs/', import.meta.url),
    ),
    fetcher: { resolve: async () => '2.0.0', metadata: async () => ({}) },
  });
it('collapses possibly unused with cautious wording and explains rows on expansion', async () => {
  const report = await discover();
  const text = formatList(report);
  expect(text).toContain(UNUSED_HINT);
  expect(text).not.toContain('orphan');
  const expanded = formatList(report, { all: true });
  expect(expanded).toContain('orphan');
  expect(expanded).toContain(
    'no static imports, script/bin usage, configuration references, stylesheet imports or HTML assets found',
  );
  expect(expanded).toContain('referenced by configuration');
  expect(text).toMatchSnapshot();
  const html = renderListHtml(report, opts);
  expect(html).toContain('<details class="notes"><summary>01 / Tooling');
  expect(html).toContain('<details class="notes"><summary>02 / Possibly unused');
  expect(html).toContain('no usage found by Uptide&#39;s scan; verify before removing');
  expect(html).toContain('no static imports, script/bin usage');
  expect(html).not.toContain('<details class="notes" open');
});
it.each([
  [
    true,
    true,
    true,
    ['01 / Packages', '02 / Tooling', '03 / Possibly unused', '04 / Incomplete discovery'],
  ],
  [false, true, false, ['01 / Tooling', '02 / Incomplete discovery']],
  [false, false, true, ['01 / Possibly unused', '02 / Incomplete discovery']],
  [false, false, false, ['01 / Incomplete discovery']],
] as const)(
  'numbers only rendered sections (used=%s tooling=%s unused=%s)',
  async (used, tooling, unused, labels) => {
    const report = await discover();
    const first = structuredClone(report.packages[0]);
    if (!first) throw new Error('missing fixture');
    first.name = 'runtime';
    first.classification = 'used';
    report.packages = [
      ...(used ? [first] : []),
      ...report.packages.filter((p) => (p.classification === 'tooling' ? tooling : unused)),
    ];
    report.failures = [
      {
        name: '@example/one',
        kind: 'registry',
        reason: 'private registry needs auth (npm.pkg.github.com), skipped',
      },
    ];
    const html = renderListHtml(report, opts);
    expect(
      html.match(/\d{2} \/ (?:Groups|Packages|Tooling|Possibly unused|Incomplete discovery)/g),
    ).toEqual(labels);
  },
);
it('renders one incomplete row per package with host-only auth diagnostics', () => {
  const failure = {
    name: '@example/one',
    kind: 'registry' as const,
    reason: 'private registry needs auth (npm.pkg.github.com), skipped',
  };
  const report: ListReport = {
    repo: '/private/repo',
    workspaces: ['.'],
    packages: [],
    groups: [],
    failures: [failure, { ...failure, workspace: 'child' }],
    timing: { totalMs: 1 },
  };
  const html = renderListHtml(report, opts);
  expect(html.match(/class="incomplete-row"/g)).toHaveLength(1);
  expect(html).toContain('@example/one</strong><span class="label">Incomplete</span>');
  expect(html).toContain(failure.reason);
  expect(html).not.toContain('/private/repo');
  const terminal = formatList(report, { width: 160 });
  expect(terminal.match(/@example\/one/g)).toHaveLength(1);
  expect(terminal).toContain(
    '@example/one: private registry needs auth (npm.pkg.github.com), skipped',
  );
});
