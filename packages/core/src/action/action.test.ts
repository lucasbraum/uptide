import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { command } from '../fix/process.js';
import { detectUpgrades, matchesPaths } from './detect.js';
import { eligible, githubComments, MARKER, type PullEvent } from './github.js';

it('detects catalog/lockfile bumps in the child importer and honors only/paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'uptide-action-detect-'));
  try {
    for (const [side, version] of [
      ['a', '3.23.8'],
      ['b', '4.6.5'],
    ]) {
      const dir = join(root, side as string);
      mkdirSync(join(dir, 'packages/app'), { recursive: true });
      writeFileSync(join(dir, 'package.json'), '{}');
      writeFileSync(
        join(dir, 'packages/app/package.json'),
        JSON.stringify({ dependencies: { zod: 'catalog:' } }),
      );
      writeFileSync(
        join(dir, 'pnpm-workspace.yaml'),
        `packages:\n  - 'packages/*'\ncatalog:\n  zod: ${version}\n`,
      );
      writeFileSync(
        join(dir, 'pnpm-lock.yaml'),
        `lockfileVersion: '9.0'\nimporters:\n  .: {}\n  packages/app:\n    dependencies:\n      zod:\n        specifier: 'catalog:'\n        version: ${version}\n`,
      );
    }
    const args = [join(root, 'a'), join(root, 'b'), ['pnpm-lock.yaml']] as const;
    expect(detectUpgrades(...args, ['zod'], ['packages/app/**'])).toEqual([
      { name: 'zod', from: '3.23.8', to: '4.6.5', workspaces: ['packages/app'] },
    ]);
    expect(detectUpgrades(...args, ['stripe'], [])).toEqual([]);
    expect(detectUpgrades(...args, ['zod'], ['packages/other/**'])).toEqual([]);
    expect(matchesPaths('src/nested/a.ts', ['src/**/*.ts'])).toBe(true);
    expect(matchesPaths('src/a.ts', ['src/**/*.ts'])).toBe(true);
    expect(matchesPaths('test/a.ts', ['src/**'])).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it('rejects non-bot and cross-repository PR events before analysis', () => {
  const e = {
    action: 'opened',
    repository: { full_name: 'a/b' },
    pull_request: {
      user: { login: 'renovate[bot]' },
      head: { sha: 'a'.repeat(40), repo: { full_name: 'a/b' } },
      base: { sha: 'b'.repeat(40), repo: { full_name: 'a/b' } },
    },
  } as PullEvent;
  expect(eligible(e, 'a/b')).toBeUndefined();
  expect(
    eligible({ ...e, pull_request: { ...e.pull_request, user: { login: 'someone' } } }, 'a/b'),
  ).toContain('author');
  expect(
    eligible(
      {
        ...e,
        pull_request: {
          ...e.pull_request,
          head: { ...e.pull_request.head, repo: { full_name: 'fork/b' } },
        },
      },
      'a/b',
    ),
  ).toContain('fork');
});
it('updates one sticky bot comment and paginates without touching unrelated comments', async () => {
  const calls: { url: string; method: string; body?: string }[] = [];
  const fetcher = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body as string });
    if (new URL(url).searchParams.get('page') === '1')
      return Response.json(
        Array.from({ length: 100 }, () => ({ id: 1, body: 'unrelated', user: { type: 'User' } })),
      );
    if (new URL(url).searchParams.get('page') === '2')
      return Response.json([{ id: 123, body: `${MARKER}\nold`, user: { type: 'Bot' } }]);
    return Response.json({});
  }) as typeof fetch;
  await githubComments('a/b', 5, 'token', 'http://fixture', fetcher).comment('updated');
  expect(calls.at(-1)).toMatchObject({
    url: 'http://fixture/repos/a/b/issues/comments/123',
    method: 'PATCH',
  });
  expect(JSON.parse(calls.at(-1)?.body ?? '{}').body).toBe(`${MARKER}\nupdated`);
  expect(calls.some((c) => c.method === 'POST')).toBe(false);
});
it('does not pass API credentials to install/test child processes', async () => {
  process.env.UPTIDE_TEST_API_KEY = 'must-not-inherit';
  try {
    const result = await command(process.cwd(), process.execPath, [
      '-e',
      'console.log(Boolean(process.env.UPTIDE_TEST_API_KEY))',
    ]);
    expect(result.output.trim()).toBe('false');
  } finally {
    delete process.env.UPTIDE_TEST_API_KEY;
  }
});

it.runIf(process.env.UPTIDE_NETWORK === '1')(
  'runs the Renovate loop with real zod, tsc, tests, sticky HTTP comment and one non-force git push',
  async () => {
    const { execFileSync } = await import('node:child_process');
    const { resolve } = await import('node:path');
    const root = mkdtempSync(join(tmpdir(), 'uptide-action-e2e-'));
    try {
      const output = execFileSync(
        'pnpm',
        ['exec', 'tsx', 'scripts/eval-action.ts', `--out=${root}`],
        {
          cwd: resolve(import.meta.dirname, '../../../..'),
          encoding: 'utf8',
          timeout: 180000,
          maxBuffer: 2 * 1024 * 1024,
        },
      );
      expect(output).toContain('1 auto-fixed · 0 fixed by the agent (LLM)');
      expect(output).toContain('Low: rule-only; all verified');
      expect(output).toContain('Sticky comment: 1 created, 1 updated');
      expect(output).toContain(
        'Failure-path test: final PR-head verification failure produces no push.',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  180000,
);
