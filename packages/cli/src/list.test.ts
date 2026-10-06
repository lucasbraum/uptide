import type { ListReport } from '@uptide/core';
import { expect, it, vi } from 'vitest';
import { run } from './cli.js';
import { formatList, groupVersions } from './format-list.js';
import { fakeEngine, memoryIo, tempRepo } from './test-utils.js';

const report: ListReport = {
  repo: '/repo',
  groups: [],
  workspaces: ['.'],
  packages: [
    {
      name: 'zod',
      current: '3.0.0',
      latest: '4.0.0',
      change: 'major',
      tier: 'verified',
      classification: 'used',
      majorGap: 1,
      reasons: [],
      workspaces: ['.'],
      usage: {
        files: 2,
        references: 0,
        callSites: 6,
        topSymbols: [{ name: 'z.object', count: 3 }],
        workspaces: ['.'],
      },
    },
    {
      name: 'minor',
      classification: 'used',
      majorGap: 0,
      reasons: [],
      current: '1.0.0',
      latest: '1.1.0',
      change: 'minor',
      tier: 'generic',
      workspaces: ['.'],
      usage: { references: 0, files: 1, callSites: 1, topSymbols: [], workspaces: ['.'] },
    },
    {
      name: 'tool',
      classification: 'tooling',
      majorGap: 1,
      reasons: ['used by scripts'],
      current: '1.0.0',
      latest: '2.0.0',
      change: 'major',
      tier: 'generic',
      workspaces: ['.'],
      usage: { references: 0, files: 0, callSites: 0, topSymbols: [], workspaces: [] },
    },
  ],
  failures: [],
  timing: { totalMs: 1 },
};
it('collapses minor/patch rows, separates unused packages and suggests the top imported package', () => {
  const text = formatList(report);
  expect(text).toContain('+ 1 minor/patch · --all');
  expect(text).not.toContain('minor  1.0.0 → 1.1.0');
  expect(text).toContain('TOOLING  1 package, used by scripts and config · --all');
  expect(text).not.toContain('consider removing');
  expect(text.trim().split('\n').at(-1)).toBe('Next  npx uptide check zod');
  expect(formatList(report, { all: true })).toMatch(/minor +1.0.0 → 1.1.0/);
});
it('lists without node_modules and never calls check; JSON retains every entry', async () => {
  const cwd = tempRepo({ 'package.json': '{"name":"shop"}', 'package-lock.json': '{}' });
  const check = vi.fn();
  const engine = fakeEngine({ list: async () => report, check });
  const io = memoryIo({ cwd });
  expect(await run(['list', '--json'], io, engine)).toBe(0);
  expect(JSON.parse(io.stdout())).toEqual(report);
  expect(check).not.toHaveBeenCalled();
  expect(
    await run(
      ['list'],
      memoryIo({ cwd }),
      fakeEngine({
        list: async () => ({ ...report, failures: [{ name: 'missing', reason: 'offline' }] }),
      }),
    ),
  ).toBe(2);
});

it('passes --no-advisories to discovery, and leaves the config to decide without it', async () => {
  const cwd = tempRepo({ 'package.json': '{"name":"shop"}', 'package-lock.json': '{}' });
  const list = vi.fn(async (_request: { advisories?: boolean }) => report);
  await run(['list', '--json', '--no-advisories'], memoryIo({ cwd }), fakeEngine({ list }));
  await run(['list', '--json'], memoryIo({ cwd }), fakeEngine({ list }));
  expect(list.mock.calls.map(([request]) => request.advisories)).toEqual([false, undefined]);
});

it('checks a priority at its smallest fix, and says advisories were not checked when off', () => {
  const text = formatList(
    {
      ...report,
      advisories: { status: 'not checked', packages: 0, reason: 'turned off with --no-advisories' },
      priorities: [
        {
          name: 'moment',
          packages: ['moment'],
          signal: 'security',
          tier: 'urgent',
          urgency: 5.3,
          effort: 1,
          reason: '2 advisories (2 high), fixed in 2.29.4 (patch, same major)',
          sameMajorFix: true,
          target: 'moment@2.29.4',
        },
      ],
    },
    { width: 160 },
  );
  expect(text).toContain('advisories not checked (turned off with --no-advisories)');
  expect(text).toContain('uptide check moment --target moment@2.29.4');
});

it('accepts one positional fix package and rejects extra names', async () => {
  const engine = fakeEngine();
  const io = memoryIo();
  expect(await run(['fix', 'zod', 'stripe'], io, engine)).toBe(2);
  expect(engine.calls).toEqual([]);
});

it('prints singular usage, references, major gaps, groups and workspace columns only in workspaces', () => {
  const grouped = structuredClone(report);
  const first = grouped.packages[0];
  if (!first) throw new Error('missing fixture');
  Object.assign(first, {
    name: '@nestjs/common',
    current: '10.0.0',
    latest: '12.0.0',
    majorGap: 2,
  });
  first.usage = {
    files: 1,
    references: 1,
    callSites: 0,
    topSymbols: [{ name: 'notUsed', count: 0 }],
    workspaces: ['.'],
    fileList: ['src/main.ts'],
  };
  const second = { ...first, name: '@nestjs/core' };
  grouped.packages.push(second);
  grouped.groups = [{ id: 'nestjs', name: '@nestjs/*', members: [first, second] }];
  // JSON reports must render the same as the original objects (no identity dependence).
  const text = formatList(JSON.parse(JSON.stringify(grouped)));
  expect(text).toMatch(/@nestjs\/\* +2 packages/);
  expect(text.match(/@nestjs\/common +10/g)).toHaveLength(1);
  expect(text).toMatch(/2 majors behind +1 file +1 ref +verified/);
  expect(text).not.toContain('0 call sites');
  expect(text).not.toContain('notUsed');
  expect(text).not.toContain('src/main.ts');
  expect(text).not.toMatch(/ · \.(?:\n|$)/);
  expect(text.trim().split('\n').at(-1)).toBe('Next  npx uptide check --group nestjs');
  expect(formatList(grouped, { all: true })).toMatch(/1 file +1 call/);
  expect(formatList(grouped, { details: true })).toContain('src/main.ts');
  grouped.workspaces = ['.', 'packages/api'];
  first.workspaces = ['packages/api'];
  expect(formatList(grouped)).toContain('packages/api');
});

it('keeps tooling-group peers in their collapsed group instead of dropping them', () => {
  const result = structuredClone(report);
  const tool = result.packages.find((p) => p.name === 'tool');
  if (!tool) throw new Error('missing tool');
  const peer = { ...tool, name: 'tool-peer', classification: 'peer' as const, peerOf: ['tool'] };
  result.packages.push(peer);
  result.groups = [{ id: 'tool', name: 'tool', members: [tool, peer] }];
  const text = formatList(result, { all: true });
  expect(text).toContain('tool-peer');
  expect(text).toContain('peer of tool');
  expect(text).toContain('uptide check --group tool');
});

it('returns incomplete discovery and preserves unknown packages in JSON', async () => {
  const unknown = [
    {
      name: 'jquery',
      currentVersions: ['1.0.0'],
      workspaces: ['.'],
      reason: 'timed out on registry.npmjs.org, skipped',
    },
  ];
  const cwd = tempRepo({ 'package.json': '{"name":"shop"}', 'package-lock.json': '{}' });
  const io = memoryIo({ cwd });
  const engine = fakeEngine({
    list: async () => ({
      ...report,
      unknown,
      failures: [
        { name: 'jquery', kind: 'registry', reason: 'timed out on registry.npmjs.org, skipped' },
      ],
    }),
  });
  expect(await run(['list', '--json'], io, engine)).toBe(2);
  expect(JSON.parse(io.stdout()).unknown).toEqual(unknown);
  expect(JSON.parse(io.stdout()).packages).toHaveLength(3);
});

it('names each target major when a group reaches several, a family once', () => {
  const member = (name: string, latest: string) =>
    ({ name, latest, current: '1.0.0' }) as ListReport['packages'][number];
  const group = (members: ListReport['packages']) => ({
    id: 'ai',
    name: 'ai + @ai-sdk/*',
    members,
  });
  expect(
    groupVersions(
      group([
        member('ai', '7.0.1'),
        member('@ai-sdk/openai', '4.0.0'),
        member('@ai-sdk/react', '4.1.0'),
      ]),
    ),
  ).toBe('→ ai 7 · @ai-sdk/* 4');
  expect(
    groupVersions(group([member('ai', '7.0.1'), member('@ai-sdk/openai-compatible', '3.0.0')])),
  ).toBe('→ ai 7 · @ai-sdk/openai-compatible 3');
  expect(
    groupVersions(group([member('@nestjs/core', '12.0.0'), member('@nestjs/common', '12.1.0')])),
  ).toBe('→ 12.x');
  // Two majors of one family would both read `@supabase/*`: the majors alone say more.
  expect(
    groupVersions(
      group([
        member('@supabase/supabase-js', '2.117.2'),
        member('@supabase/auth-js', '2.117.2'),
        member('@supabase/config', '0.11.1'),
        member('@supabase/sql-to-rest', '0.1.8'),
      ]),
    ),
  ).toBe('→ 2.x · 0.x');
});

const pkg = (
  name: string,
  over: Partial<ListReport['packages'][number]> = {},
): ListReport['packages'][number] => ({
  name,
  current: '1.0.0',
  latest: '2.0.0',
  change: 'major',
  tier: 'generic',
  classification: 'used',
  majorGap: 1,
  reasons: [],
  workspaces: ['apps/a'],
  usage: { files: 3, callSites: 4, references: 0, topSymbols: [], workspaces: ['apps/a'] },
  ...over,
});
const monorepo = (packages: ListReport['packages']): ListReport => ({
  repo: '/repo',
  groups: [],
  workspaces: ['apps/a', 'apps/b', 'apps/c'],
  packages,
  failures: [],
  timing: { totalMs: 1 },
});

it('shows a package installed at several versions once, with where they are', () => {
  const ai = pkg('ai', {
    current: '5.0.52',
    latest: '7.0.128',
    majorGap: 2,
    versions: [
      { version: '5.0.52', workspaces: ['apps/a'] },
      { version: '7.0.59', workspaces: ['apps/b', 'apps/c'] },
    ],
    workspaces: ['apps/a', 'apps/b', 'apps/c'],
  });
  const text = formatList(monorepo([ai]), { width: 160 });
  expect(text.match(/^ {2}ai /gm)).toHaveLength(1);
  expect(text).toMatch(
    /ai +5\.0\.52, 7\.0\.59 → 7\.0\.128 +2 majors behind +3 files +4 calls +2 versions in 3 workspaces\n/,
  );
  // Too narrow for the last column: the spread goes under the row instead of away.
  expect(formatList(monorepo([ai]), { width: 64 })).toMatch(
    /ai +5\.0\.52, 7\.0\.59 → 7\.0\.128 +2 majors behind[^\n]*\n {4}2 versions in 3 workspaces\n/,
  );
  const shiki = pkg('shiki', {
    versions: ['1.6.0', '3.13.0', '4.0.1'].map((version) => ({ version, workspaces: [version] })),
  });
  expect(formatList(monorepo([shiki]), { width: 160 })).toContain('1.6.0 … 4.0.1 → 2.0.0');
});

it('never truncates a name: the row narrows from the right, a name past the cap wraps', () => {
  const long = '@graphql-codegen/typescript-react-apollo-operations-plugin'; // 58 characters
  const text = formatList(
    monorepo([pkg('@graphql-codegen/typescript-operations'), pkg(long), pkg('zod')]),
    { width: 80 },
  );
  expect(text).not.toMatch(/@graphql\S*…/);
  // The column fits the longest name up to the cap; trailing columns go first.
  expect(text).toMatch(
    / {2}@graphql-codegen\/typescript-operations {10}1\.0\.0 → 2\.0\.0 {3}major\n/,
  );
  // The long name alone on its line, the row under it at the name column's width.
  expect(text).toContain(`  ${long}\n${' '.repeat(2 + 45 + 3)}1.0.0 → 2.0.0`);
});

it('splits priorities into urgent, and worth planning collapsed to its count', () => {
  const rows: NonNullable<ListReport['priorities']> = [
    {
      name: 'lodash',
      packages: ['lodash'],
      signal: 'security',
      tier: 'urgent',
      urgency: 5.3,
      effort: 1,
      reason: '1 advisory (1 high), fixed in 4.18.0 (minor, same major)',
    },
    {
      name: 'request',
      packages: ['request'],
      signal: 'deprecated',
      tier: 'urgent',
      urgency: 4,
      effort: 1,
      reason: 'deprecated: request has been deprecated',
    },
    {
      name: 'ai',
      packages: ['ai'],
      signal: 'drift',
      tier: 'planning',
      urgency: 2.5,
      effort: 3,
      reason: 'version drift: 5.x and 7.x across 3 workspaces',
    },
  ];
  const text = formatList(
    { ...monorepo([pkg('lodash'), pkg('request'), pkg('ai')]), priorities: rows },
    { width: 160 },
  );
  expect(text).toContain('  Urgent  2 · advisories, deprecations\n    lodash ');
  expect(text).toContain('    request ');
  expect(text).toContain(
    '  Worth planning  1 · unsupported, drift, blocking, majors behind · --all\n',
  );
  expect(text).not.toContain('version drift');
  const all = formatList(
    { ...monorepo([pkg('lodash'), pkg('request'), pkg('ai')]), priorities: rows },
    { width: 160, all: true },
  );
  expect(all).toMatch(
    /Worth planning {2}1 · [^\n]*\n {4}ai +version drift: 5\.x and 7\.x across 3 workspaces/,
  );
});

it('shows a compiler or bundler major under a collapsed TOOLING, with why', () => {
  const text = formatList(
    monorepo([
      pkg('typescript', {
        classification: 'tooling',
        reasons: ['known configuration or build tool'],
        current: '5.9.0',
        latest: '6.0.2',
      }),
      pkg('esbuild', {
        classification: 'tooling',
        reasons: ['known configuration or build tool'],
        current: '0.25.0',
        latest: '0.27.0',
        change: 'minor',
        majorGap: 0,
      }),
    ]),
    { width: 120 },
  );
  expect(text).toMatch(
    /TOOLING {2}2 packages[^\n]*--all\n {2}typescript +5\.9\.0 → 6\.0\.2 +major[^\n]*\n {4}compiler major: check build and tsconfig\n/,
  );
  expect(text).not.toMatch(/^ {2}esbuild/m);
});
