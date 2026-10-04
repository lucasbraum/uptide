import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ListReport, listDependencies } from '@uptide/core';
import { afterEach, expect, it } from 'vitest';
import { run } from './cli.js';
import { formatList, formatListTimings } from './format-list.js';
import { renderListHtml } from './html/list.js';
import { fakeEngine, memoryIo } from './test-utils.js';

const roots: string[] = [];
afterEach(() => {
  for (const cwd of roots.splice(0)) rmSync(cwd, { recursive: true, force: true });
});
it.each([false, true])(
  'emits verbose phase timings to stderr, preserving stdout (JSON=%s)',
  async (json) => {
    const cwd = mkdtempSync(join(tmpdir(), 'uptide-list-verbose-'));
    roots.push(cwd);
    writeFileSync(
      join(cwd, 'package.json'),
      JSON.stringify({ name: 'synthetic-verbose', dependencies: { husky: '1.0.0' } }),
    );
    writeFileSync(join(cwd, 'package-lock.json'), '{}');
    writeFileSync(join(cwd, '.huskyrc'), '{"hooks":{"pre-commit":"echo synthetic"}}');
    const engine = fakeEngine({
      list: (opts) =>
        listDependencies({
          ...opts,
          fetcher: { resolve: async () => '2.0.0', metadata: async () => ({}) },
        }),
    });
    const io = memoryIo({ cwd });
    expect(await run(['list', '--verbose', ...(json ? ['--json'] : [])], io, engine)).toBe(0);
    for (const phase of ['manifest read', 'registry', 'source scan', 'config scan', 'render'])
      expect(io.stderr()).toMatch(new RegExp(`${phase} +[0-9.]+ ms`));
    expect(io.stderr()).toContain('1 config file');
    expect(io.stderr()).toContain('1 package manifest');
    expect(io.stderr()).toContain('3 visited');
    if (json) {
      const report = JSON.parse(io.stdout());
      expect(report.timing.phases.registryMs).toBeGreaterThanOrEqual(0);
      expect(report.timing.files.config).toBe(1);
    }
    const normal = memoryIo({ cwd });
    expect(await run(['list', ...(json ? ['--json'] : [])], normal, engine)).toBe(0);
    expect(normal.stderr()).not.toContain('source scan');
    if (json) expect(JSON.parse(normal.stdout()).timing.phases).toBeUndefined();
  },
);
it('formats all five timings and file counts deterministically', () => {
  const report: ListReport = {
    repo: '/repo',
    workspaces: ['.'],
    packages: [],
    groups: [],
    failures: [],
    timing: {
      totalMs: 32,
      phases: { manifestReadMs: 1.25, registryMs: 20, sourceScanMs: 8.25, configScanMs: 2.5 },
      files: {
        manifests: 1,
        installedManifests: 6,
        visited: 48,
        source: 36,
        config: 3,
        assets: 5,
        parsed: 7,
        workers: 2,
        skipped: {
          '.gitignore': { files: 4, directories: 1 },
          'no dependency text': { files: 29, directories: 0 },
        },
      },
    },
  };
  expect(formatListTimings(report, 1.5)).toMatchSnapshot();
});
it.each([
  [[403, 403, 403], '3 not checked (access denied)'],
  [[401, 401], '2 not checked (auth required)'],
  [[404, 404], '2 not checked (not found)'],
  [[0, 0], '2 not checked (timed out)'],
  [[403, 0], '2 not checked'],
] as const)(
  'uses the actual failure reason or no suffix for mixed reasons (%j)',
  (statuses, label) => {
    const failures = statuses.map((status, i) => ({
      name: `package-${i}`,
      status,
      summary:
        status === 403
          ? 'access denied (403)'
          : status === 401
            ? 'auth required (401)'
            : status === 404
              ? 'not found (404)'
              : 'timed out',
      reason: 'synthetic failure',
    }));
    const report: ListReport = {
      repo: '/repo',
      workspaces: ['.'],
      packages: [],
      groups: [],
      failures,
      unknown: failures.map((f) => ({
        name: f.name,
        currentVersions: ['1.0.0'],
        workspaces: ['.'],
        reason: f.reason,
      })),
      timing: { totalMs: 1 },
    };
    expect(formatList(report)).toContain(label);
    const html = renderListHtml(report, { version: '0.1.0', date: '2026-10-04T22:00:00Z' });
    expect(html).toContain(`${label}. Latest versions are unknown.`);
    if (statuses.some((status) => status === 403) && statuses.some((status) => status === 0))
      expect(formatList(report).split('\n')[2]).not.toMatch(/not checked \(/);
  },
);
