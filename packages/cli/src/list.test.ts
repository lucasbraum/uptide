import type { ListReport } from '@uptide/core';
import { expect, it, vi } from 'vitest';
import { run } from './cli.js';
import { formatList } from './format-list.js';
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
  expect(text.trim().split('\n').at(-1)).toBe('Next  uptide check zod');
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
  expect(text).toMatch(/major ×2 +1 file +1 ref +verified/);
  expect(text).not.toContain('0 call sites');
  expect(text).not.toContain('notUsed');
  expect(text).not.toContain('src/main.ts');
  expect(text).not.toMatch(/ · \.(?:\n|$)/);
  expect(text.trim().split('\n').at(-1)).toBe('Next  uptide check --group nestjs');
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
