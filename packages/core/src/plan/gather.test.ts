import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import { type ListReport, listDependencies } from '../list/list.js';
import { upgradePlan } from './gather.js';

it('plans discovery with unknown effort, never fetches tarballs, and consumes only matching results', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'uptide-plan-'));
  try {
    writeFileSync(join(cwd, 'package.json'), '{}');
    const discovery: ListReport = {
      repo: cwd,
      groups: [],
      workspaces: ['.'],
      packages: [
        {
          name: 'zod',
          current: '3.25.76',
          latest: '4.6.5',
          change: 'major',
          tier: 'verified',
          classification: 'used',
          majorGap: 1,
          reasons: [],
          workspaces: ['.'],
          usage: { references: 0, files: 2, callSites: 8, topSymbols: [], workspaces: ['.'] },
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

it('plans each installed version of a package listed once with versions[]', async () => {
  // fixtures/repos/list-accuracy/version-drift: drift-sdk 5.0.0 in apps/a, 7.0.0 in apps/b and c.
  const cwd = fileURLToPath(
    new URL('../../../../fixtures/repos/list-accuracy/version-drift/', import.meta.url),
  );
  const latest: Record<string, string> = {
    'drift-sdk': '7.1.0',
    '@drift/core': '3.0.0',
    '@drift/react': '3.0.0',
  };
  const fetcher = {
    fetch: vi.fn(),
    resolve: async (name: string) => latest[name] as string,
    metadata: async () => ({ peerDependencies: {} }),
  };
  const discovery = await listDependencies({ cwd, fetcher });
  expect(discovery.packages.filter((p) => p.name === 'drift-sdk')).toHaveLength(1);
  const { report, plan } = await upgradePlan({ cwd }, { list: async () => discovery, fetcher });
  expect(
    report.packages
      .filter((p) => p.name === 'drift-sdk')
      .map((p) => [p.installed, p.target, p.workspaces, p.majorsBehind]),
  ).toEqual([
    ['5.0.0', '7.1.0', ['apps/a'], 2],
    ['7.0.0', '7.1.0', ['apps/b', 'apps/c'], 0],
  ]);
  expect(plan.notes).toContain(
    'drift-sdk: current versions 5.0.0 (apps/a); 7.0.0 (apps/b, apps/c); one target for all, highest estimated effort shown.',
  );
});
