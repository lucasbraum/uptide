import type { ListReport } from '@uptide/core';
import { expect, it, vi } from 'vitest';
import { run } from './cli.js';
import { formatList } from './format-list.js';
import { fakeEngine, memoryIo, tempRepo } from './test-utils.js';

const report: ListReport = {
  repo: '/repo',
  workspaces: ['.'],
  packages: [
    {
      name: 'zod',
      current: '3.0.0',
      latest: '4.0.0',
      change: 'major',
      tier: 'verified',
      workspaces: ['.'],
      usage: {
        files: 2,
        callSites: 6,
        topSymbols: [{ name: 'z.object', count: 3 }],
        workspaces: ['.'],
      },
    },
    {
      name: 'minor',
      current: '1.0.0',
      latest: '1.1.0',
      change: 'minor',
      tier: 'generic',
      workspaces: ['.'],
      usage: { files: 1, callSites: 1, topSymbols: [], workspaces: ['.'] },
    },
    {
      name: 'tool',
      current: '1.0.0',
      latest: '2.0.0',
      change: 'major',
      tier: 'generic',
      workspaces: ['.'],
      usage: { files: 0, callSites: 0, topSymbols: [], workspaces: [] },
    },
  ],
  failures: [],
  timing: { totalMs: 1 },
};
it('collapses minor/patch rows, separates unused packages and suggests the top imported package', () => {
  const text = formatList(report);
  expect(text).toContain('1 minor/patch upgrades (minor)');
  expect(text).not.toContain('minor  1.0.0 → 1.1.0');
  expect(text).toContain('not imported anywhere, consider removing');
  expect(text.trim().split('\n').at(-1)).toBe('Next: npx uptide check zod');
  expect(formatList(report, { all: true })).toContain('minor  1.0.0 → 1.1.0');
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

it('accepts one positional fix package and rejects extra names', async () => {
  const engine = fakeEngine();
  const io = memoryIo();
  expect(await run(['fix', 'zod', 'stripe'], io, engine)).toBe(2);
  expect(engine.calls).toEqual([]);
});
