import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { listDependencies } from './list.js';
import type { Advisory } from './priorities.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
/** A copy of the synthetic priorities app, and a registry answering from its recordings. */
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'uptide-priorities-'));
  roots.push(cwd);
  cpSync(
    fileURLToPath(new URL('../../../../fixtures/repos/list-accuracy/priorities/', import.meta.url)),
    cwd,
    { recursive: true },
  );
  const registry = JSON.parse(readFileSync(join(cwd, 'registry.json'), 'utf8')) as Record<
    string,
    { latest: string; versions: Record<string, { deprecated?: string }> }
  >;
  const recorded = JSON.parse(readFileSync(join(cwd, 'advisories.json'), 'utf8')) as Record<
    string,
    Advisory[]
  >;
  const advisories = vi.fn(async (query: Map<string, string[]>) => ({
    checked: [...query.keys()],
    advisories: recorded,
  }));
  const entry = (n: string) => registry[n] as (typeof registry)[string];
  return {
    cwd,
    advisories,
    fetcher: {
      resolve: async (n: string) => entry(n).latest,
      metadata: async () => ({ peerDependencies: {} }),
      deprecation: async (n: string, v: string) => entry(n).versions[v]?.deprecated,
      versions: async (n: string) => Object.keys(entry(n).versions),
      advisories,
    },
  };
}

it('ranks runtime before dev and same-major fixes before major-only ones, with the fix to check', async () => {
  const { cwd, fetcher, advisories } = fixture();
  const report = await listDependencies({ cwd, fetcher });
  expect(advisories).toHaveBeenCalledTimes(1);
  expect(report.advisories).toEqual({ status: 'checked', packages: 5 });
  expect(report.packages.find((p) => p.name === 'minimist')?.kind).toBe('dev');
  expect(report.packages.find((p) => p.name === 'lodash')?.kind).toBe('runtime');
  expect(report.priorities?.map((p) => [p.name, p.reason, p.target])).toEqual([
    ['moment', '2 advisories (2 high), fixed in 2.29.4 (patch, same major)', 'moment@2.29.4'],
    ['lodash', '6 advisories (3 high), fixed in 4.18.0 (minor, same major)', 'lodash@4.18.0'],
    ['jsonwebtoken', '3 advisories (1 high), needs 9.0.0 (major)', 'jsonwebtoken@9.0.0'],
    // A critical advisory in a dev-only package ranks with a runtime high, after it.
    [
      'minimist',
      'dev · 1 advisory (1 critical), fixed in 1.2.6 (patch, same major)',
      'minimist@1.2.6',
    ],
    ['uuid', '1 advisory (1 moderate), needs 11.1.1 (major)', 'uuid@11.1.1'],
  ]);
});

it('sends nothing to the advisory endpoint with --no-advisories, and says so', async () => {
  const { cwd, fetcher, advisories } = fixture();
  const report = await listDependencies({ cwd, fetcher, advisories: false });
  expect(advisories).not.toHaveBeenCalled();
  expect(report.advisories).toEqual({
    status: 'not checked',
    packages: 0,
    reason: 'turned off with --no-advisories',
  });
  // Without advisories, the deprecation is uuid's most urgent signal.
  expect(report.priorities?.[0]).toMatchObject({ name: 'uuid', signal: 'deprecated' });
});

it('reads "advisories": false from uptide.config.json, and rejects anything but a boolean', async () => {
  const { cwd, fetcher, advisories } = fixture();
  writeFileSync(join(cwd, 'uptide.config.json'), JSON.stringify({ advisories: false }));
  const report = await listDependencies({ cwd, fetcher });
  expect(advisories).not.toHaveBeenCalled();
  expect(report.advisories?.reason).toBe('turned off in uptide.config.json');
  // An explicit option wins over the file (the CLI passes false only for --no-advisories).
  await listDependencies({ cwd, fetcher, advisories: true });
  expect(advisories).toHaveBeenCalledTimes(1);
  writeFileSync(join(cwd, 'uptide.config.json'), JSON.stringify({ advisories: 'no' }));
  await expect(listDependencies({ cwd, fetcher })).rejects.toThrow(
    'uptide.config.json accepts only provider and model strings, and advisories as true or false.',
  );
});
