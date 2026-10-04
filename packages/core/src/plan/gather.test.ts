import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { ListReport } from '../list/list.js';
import { upgradePlan } from './gather.js';

it('plans discovery with unknown effort, never fetches tarballs, and consumes only matching results', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'uptide-plan-'));
  try {
    writeFileSync(join(cwd, 'package.json'), '{}');
    const discovery: ListReport = {
      repo: cwd,
      workspaces: ['.'],
      packages: [
        {
          name: 'zod',
          current: '3.25.76',
          latest: '4.6.5',
          change: 'major',
          tier: 'verified',
          workspaces: ['.'],
          usage: { files: 2, callSites: 8, topSymbols: [], workspaces: ['.'] },
        },
      ],
      failures: [],
      timing: { totalMs: 1 },
    };
    const fetch = vi.fn(async () => {
      throw new Error('must not download');
    });
    const services = {
      list: async () => discovery,
      fetcher: {
        fetch,
        resolve: async () => '4.6.5',
        metadata: async () => ({ peerDependencies: {} }),
      },
    };
    const result = await upgradePlan({ cwd }, services);
    expect(result.plan.steps[0]?.effort).toBe('unknown');
    expect(fetch).not.toHaveBeenCalled();
    const saved = structuredClone(result.report);
    (saved.packages[0] as NonNullable<(typeof saved.packages)[0]>).status = 'safe';
    const known = await upgradePlan({ cwd, checkResults: saved }, services);
    expect(known.plan.steps[0]?.effort).toBe('none');
    (saved.packages[0] as NonNullable<(typeof saved.packages)[0]>).target = '4.0.0';
    expect((await upgradePlan({ cwd, checkResults: saved }, services)).plan.steps[0]?.effort).toBe(
      'unknown',
    );
    await expect(
      upgradePlan({ cwd, checkResults: { ...saved, repo: '/different' } }, services),
    ).rejects.toThrow('this repository');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
