import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listDependencies } from '@uptide/core';
import { afterEach, expect, it, vi } from 'vitest';
import { run } from './cli.js';
import { formatList } from './format-list.js';
import { renderListHtml } from './html/list.js';
import { fakeEngine, memoryIo } from './test-utils.js';

const fixture = fileURLToPath(
  new URL('../../../fixtures/repos/list-accuracy/dependency-sources/', import.meta.url),
);
const roots: string[] = [];
const root = (): string => {
  const cwd = mkdtempSync(join(tmpdir(), 'uptide-cli-sources-'));
  roots.push(cwd);
  cpSync(fixture, cwd, { recursive: true });
  return cwd;
};
afterEach(() => {
  for (const cwd of roots.splice(0)) rmSync(cwd, { recursive: true, force: true });
});
const htmlOpts = { version: '0.2.0', date: '2026-10-04T22:00:00Z', timeZone: 'UTC' };
const fetcher = { resolve: async () => '2.0.0', metadata: async () => ({}) };

it.each([false, true])(
  'collapses non-registry sources by reason in the terminal (TTY=%s)',
  async (color) => {
    const report = await listDependencies({ cwd: root(), fetcher });
    const text = formatList(report, { color });
    expect(text).toMatchSnapshot();
    expect(text).toContain('not checked: non-registry source (github)');
    expect(text).not.toContain('github-protocol');
    expect(text).not.toContain('not checked (network)');
    expect(text).not.toContain('Every direct dependency is up to date');
    for (const skipped of report.skipped ?? []) {
      expect(formatList(report, { all: true })).toContain(skipped.name);
      expect(formatList(report, { details: true })).toContain(skipped.name);
    }
  },
);
it('renders one collapsed non-registry HTML section with reasons, no paths/URLs, and sequential numbering', async () => {
  const report = await listDependencies({ cwd: root(), fetcher });
  const html = renderListHtml(report, htmlOpts);
  expect(html).toContain(
    '<details class="notes"><summary>03 / Not checked / 22 non-registry sources</summary>',
  );
  expect(html).not.toContain('<details class="notes" open');
  expect(html).not.toContain('Incomplete discovery');
  expect(html).not.toMatch(/synthetic-private|example\.invalid|example\/synthetic/);
  expect(html.match(/class="source-row"/g)).toHaveLength(22);
  for (const item of report.skipped ?? []) expect(html).toContain(item.reason);
});
it('exits 0 with only skipped sources, retains JSON entries, and does not claim every dependency is up to date', async () => {
  const cwd = root();
  const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
  for (const name of ['registry-alias', 'scoped-alias', 'tool-alias', 'ordinary'])
    delete pkg.dependencies[name];
  writeFileSync(join(cwd, 'package.json'), JSON.stringify(pkg));
  const resolve = vi.fn(async () => {
    throw new Error('no registry requests expected');
  });
  const engine = fakeEngine({
    list: (opts) => listDependencies({ ...opts, fetcher: { resolve } }),
  });
  const io = memoryIo({ cwd });
  expect(await run(['list', '--json', '--html', 'report.html'], io, engine)).toBe(0);
  const report = JSON.parse(io.stdout());
  expect(report.skipped).toHaveLength(22);
  expect(report.unknown).toEqual([]);
  expect(report.failures).toEqual([]);
  expect(resolve).not.toHaveBeenCalled();
  const html = readFileSync(join(cwd, 'report.html'), 'utf8');
  expect(html).toContain('01 / Not checked');
  expect(html).not.toContain('Every direct dependency is up to date');
});
it.each(['network', 'auth', 'malformed'] as const)(
  'still exits 2 for a real %s failure mixed with skipped sources',
  async (failure) => {
    const cwd = root();
    writeFileSync(
      join(cwd, 'package.json'),
      JSON.stringify({
        name: 'app',
        dependencies: {
          github: 'github:example/synthetic',
          broken: failure === 'malformed' ? 42 : '1.0.0',
        },
      }),
    );
    const io = memoryIo({ cwd });
    const engine = fakeEngine({
      list: (opts) =>
        listDependencies({
          ...opts,
          fetcher: {
            resolve: async () => {
              throw Object.assign(new Error('synthetic registry failure'), {
                code: failure === 'auth' ? 'REGISTRY_AUTH' : 'REGISTRY_UNREACHABLE',
              });
            },
          },
        }),
    });
    expect(await run(['list', '--json'], io, engine)).toBe(2);
    const report = JSON.parse(io.stdout());
    expect(report.skipped).toHaveLength(1);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0].name).toBe('broken');
  },
);
it.each(['{"name":"broken","dependencies":', '{"name":"broken","dependencies":["invalid"]}'])(
  'exits 2 for malformed package manifests',
  async (manifest) => {
    const cwd = root();
    writeFileSync(join(cwd, 'package.json'), manifest);
    expect(
      await run(
        ['list'],
        memoryIo({ cwd }),
        fakeEngine({ list: (opts) => listDependencies({ ...opts, fetcher }) }),
      ),
    ).toBe(2);
  },
);
it('does not overwrite terminal rows for identical alias names/versions with different real targets', async () => {
  const report = await listDependencies({ cwd: root(), fetcher });
  const first = report.packages.find((p) => p.name === 'registry-alias');
  if (!first) throw new Error('missing alias fixture');
  report.packages = [first, { ...first, registryName: 'another-real', latest: '3.0.0' }];
  report.groups = [];
  const text = formatList(report);
  expect(text).toContain('1.0.0 → 2.0.0');
  expect(text).toContain('1.0.0 → 3.0.0');
});
