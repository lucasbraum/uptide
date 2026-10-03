import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { storedRunDir } from './isolate.js';
import { openPr } from './pr.js';
import { git } from './process.js';
import type { FixReport } from './types.js';

const scratch = mkdtempSync(join(tmpdir(), 'uptide-pr-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

it('loads the stored run for the branch, refuses a branch that moved, and opens the PR with --yes', async () => {
  const root = join(scratch, 'repo');
  mkdirSync(root);
  writeFileSync(join(root, 'package.json'), '{"name":"repo"}');
  git(root, 'init');
  git(root, 'config', 'user.email', 'test@example.test');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'baseline');
  git(root, 'branch', 'uptide/zod-4.6.5');
  const head = git(root, 'rev-parse', 'uptide/zod-4.6.5');
  const dir = storedRunDir(root, 'uptide/zod-4.6.5');
  mkdirSync(dir, { recursive: true });
  const report: FixReport = {
    repo: root,
    package: 'zod',
    from: '3.25.76',
    target: '4.6.5',
    branch: 'uptide/zod-4.6.5',
    head,
    sites: [],
    verification: {
      baseline: [],
      target: [],
      after: [],
      newErrors: [],
      baselineTests: [],
      tests: [],
      passed: true,
    },
    llm: { inputTokens: 0, outputTokens: 0, costUsd: 0, available: false },
    timingMs: 1,
    notes: [],
    prBody: join(dir, 'pr-body.md'),
  };
  writeFileSync(join(dir, 'report.json'), JSON.stringify(report));
  writeFileSync(report.prBody, '## Upgrade zod\n');
  const calls: string[][] = [];
  const printed: string[] = [];
  const io = {
    git: (cwd: string, ...args: string[]) => {
      calls.push(['git', ...args]);
      if (args[0] === 'remote') return 'https://github.com/me/repo.git';
      if (args[0] === 'push') return '';
      return git(cwd, ...args);
    },
    command: async (_cwd: string, bin: string, args: string[]) => {
      calls.push([bin, ...args]);
      return {
        code: 0,
        timeout: false,
        output:
          args[0] === 'repo'
            ? JSON.stringify({ defaultBranchRef: { name: 'main' }, nameWithOwner: 'me/repo' })
            : args[0] === 'pr' && args[1] === 'list'
              ? '[]'
              : args[1] === 'list'
                ? '[{"name":"uptide"}]'
                : 'https://github.com/me/repo/pull/7',
      };
    },
    print: (s: string) => printed.push(s),
  };
  // No --yes: the plan, nothing pushed.
  await expect(openPr({ cwd: root, branch: 'uptide/zod-4.6.5' }, io.print, io)).rejects.toThrow(
    'requires --yes',
  );
  expect(printed.join('')).toContain('Opening the PR on: me/repo');
  expect(calls.some((c) => c.includes('push'))).toBe(false);
  // --yes: pushed from the user's repository, PR opened, remembered in the stored run.
  const { url, report: after } = await openPr(
    { cwd: root, branch: 'uptide/zod-4.6.5', yes: true },
    io.print,
    io,
  );
  expect(url).toBe('https://github.com/me/repo/pull/7');
  expect(after.prUrl).toBe(url);
  expect(calls).toContainEqual([
    'git',
    'push',
    '--set-upstream',
    'origin',
    'uptide/zod-4.6.5:uptide/zod-4.6.5',
  ]);
  // The branch moved since the run: verify first.
  git(root, 'switch', '-q', 'uptide/zod-4.6.5');
  writeFileSync(join(root, 'more.txt'), 'x');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'more');
  git(root, 'switch', '-q', '-');
  await expect(
    openPr({ cwd: root, branch: 'uptide/zod-4.6.5', yes: true }, io.print, io),
  ).rejects.toThrow('run `uptide verify --branch uptide/zod-4.6.5` first');
  await expect(openPr({ cwd: root, branch: 'uptide/other' }, io.print, io)).rejects.toThrow(
    'no stored migration run for uptide/other',
  );
});
