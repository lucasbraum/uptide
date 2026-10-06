import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type ListReport, listDependencies } from '@uptide/core';
import { expect, it, vi } from 'vitest';
import { run } from './cli.js';
import { formatList } from './format-list.js';
import { renderListHtml } from './html/list.js';
import { listMetrics } from './telemetry/metrics.js';
import { fakeEngine, memoryIo, tempRepo } from './test-utils.js';

// Every consumer of list's report, against one package installed at several versions:
// fixtures/repos/list-accuracy/version-drift (invented packages).
const root = fileURLToPath(
  new URL('../../../fixtures/repos/list-accuracy/version-drift/', import.meta.url),
).replace(/\/$/, '');
const registry = JSON.parse(readFileSync(join(root, 'registry.json'), 'utf8')) as Record<
  string,
  { latest: string }
>;
const discover = (): Promise<ListReport> =>
  listDependencies({
    cwd: root,
    fetcher: {
      resolve: async (name) => registry[name]?.latest as string,
      metadata: async () => ({}),
    },
  });

it('the report: one entry per package, every installed version in versions[]', async () => {
  const report = await discover();
  expect(report.packages.map((p) => p.name).sort()).toEqual([
    '@drift/core',
    '@drift/react',
    'drift-sdk',
  ]);
  expect(report.packages.find((p) => p.name === 'drift-sdk')).toMatchObject({
    current: '5.0.0',
    latest: '7.1.0',
    majorGap: 2,
    versions: [
      { version: '5.0.0', workspaces: ['apps/a'] },
      { version: '7.0.0', workspaces: ['apps/b', 'apps/c'] },
    ],
    workspaces: ['apps/a', 'apps/b', 'apps/c'],
    usage: { files: 3 },
  });
  expect(report.packages.find((p) => p.name === '@drift/react')?.versions).toBeUndefined();
  expect(report.groups.map((g) => [g.id, g.members.map((p) => p.name)])).toEqual([
    ['drift', ['@drift/core', '@drift/react']],
  ]);
});

it('list --json prints that report, and the smoke assertions accept it', async () => {
  const io = memoryIo({ cwd: root });
  expect(await run(['list', '--json'], io, fakeEngine({ list: () => discover() }))).toBe(0);
  const listed = JSON.parse(io.stdout()) as ListReport;
  expect(listed.packages.filter((p) => p.name === 'drift-sdk')).toHaveLength(1);
  const { listReportFailures } = (await import(
    new URL('../smoke/check-output.mjs', import.meta.url).href
  )) as { listReportFailures(listed: unknown, manager: string): string[] };
  // The smoke run also requires zod; this fixture has none, so that is the only failure.
  expect(listReportFailures(listed, 'npm')).toEqual(['npm list: expected zod with usage']);
  const twice = { ...listed, packages: [...listed.packages, listed.packages[0]] };
  expect(listReportFailures(twice, 'npm')).toContain('npm list: expected one entry per package');
});

it('the terminal: one row, its versions and where they are', async () => {
  const text = formatList(await discover(), { width: 160 });
  expect(text.match(/^ {2}drift-sdk /gm)).toHaveLength(1);
  expect(text).toMatch(/drift-sdk +5\.0\.0, 7\.0\.0 → 7\.1\.0 +2 majors behind +3 files/);
  expect(text).toContain('2 versions in 3 workspaces');
});

it('the HTML report: one row per package, with every version', async () => {
  const html = renderListHtml(await discover(), { version: '0.0.0', date: '2026-10-06T00:00:00Z' });
  expect(html.match(/<article[^>]*><div class="pkg-name">drift-sdk</g)).toHaveLength(1);
  expect(html).toContain(
    '<div class="versions">5.0.0, 7.0.0 → 7.1.0<div class="muted">2 versions in 3 workspaces</div></div>',
  );
});

it('check --group checks each member once, whatever versions its workspaces are on', async () => {
  const report = await discover();
  const check = vi.fn(fakeEngine().check);
  const engine = fakeEngine({ list: async () => report, check });
  engine.installed = async () => new Map(report.packages.map((p) => [p.name, p.current]));
  engine.declared = engine.installed;
  const cwd = tempRepo({
    'package.json': JSON.stringify({
      name: 'drift',
      dependencies: { '@drift/core': '1.0.0', '@drift/react': '2.0.0' },
    }),
    'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: {} }),
    ...Object.fromEntries(
      report.packages.map((p) => [
        `node_modules/${p.name}/package.json`,
        JSON.stringify({ name: p.name, version: p.current }),
      ]),
    ),
  });
  const io = memoryIo({ cwd });
  const code = await run(['check', '--group', 'drift', '--json'], io, engine);
  rmSync(cwd, { recursive: true, force: true });
  expect(code, io.stderr()).toBe(0);
  expect(check).toHaveBeenCalledWith(
    expect.objectContaining({ only: ['@drift/core', '@drift/react'] }),
    expect.any(Function),
  );
});

it('telemetry counts each package once', async () => {
  const metrics = listMetrics(await discover());
  expect(metrics.counts?.packages).toBe(3);
  expect(metrics.packages?.find((p) => p.name === 'drift-sdk')).toEqual({
    name: 'drift-sdk',
    versions: ['5.0.0', '7.1.0'],
  });
});
