import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { retainedDiffs, updatePrBody } from './pr-body.js';
import { prBody } from './report.js';
import type { FixReport } from './types.js';

const temp = mkdtempSync(join(tmpdir(), 'uptide-body-test-'));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
function mock() {
  const report = JSON.parse(
    readFileSync(new URL('./__fixtures__/storefront-zod.json', import.meta.url), 'utf8'),
  ) as FixReport;
  report.head = 'abc';
  report.uptideDirty = false;
  report.prUrl = 'https://github.com/owner/demo/pull/82';
  const run = join(temp, 'report.json');
  writeFileSync(run, JSON.stringify(report));
  const calls: string[][] = [];
  let sent = '';
  return {
    report,
    run,
    calls,
    sent: () => sent,
    io: {
      tool: { uptideDirty: false },
      git: (_cwd: string, ...args: string[]) => {
        calls.push(['git', ...args]);
        return '';
      },
      command: async (_cwd: string, bin: string, args: string[]) => {
        calls.push([bin, ...args]);
        if (args[1] === 'edit')
          sent = readFileSync(args[args.indexOf('--body-file') + 1] ?? '', 'utf8');
        return {
          code: 0,
          timeout: false,
          output: JSON.stringify({
            url: report.prUrl,
            headRefName: report.branch,
            headRefOid: report.head,
          }),
        };
      },
    },
  };
}
it('previews the complete stored run without mutating GitHub or git', async () => {
  const m = mock();
  const result = await updatePrBody({ cwd: temp, pr: '82', run: m.run, preview: true }, m.io);
  expect(result.body).toBe(prBody(m.report));
  expect(result.updated).toBe(false);
  expect(m.calls.filter((c) => c[0] === 'gh')).toEqual([
    ['gh', 'pr', 'view', '82', '--json', 'url,headRefName,headRefOid'],
  ]);
  expect(m.calls.flat()).not.toContain('push');
  expect(readFileSync(m.run, 'utf8')).toBe(JSON.stringify(m.report));
});
it('defaults to .uptide/report.json and updates only the PR body through a body file', async () => {
  const m = mock();
  mkdirSync(join(temp, '.uptide'), { recursive: true });
  writeFileSync(join(temp, '.uptide/report.json'), JSON.stringify(m.report));
  const result = await updatePrBody({ cwd: temp, pr: '82' }, m.io);
  expect(result.updated).toBe(true);
  expect(m.sent()).toBe(result.body);
  expect(m.calls.filter((c) => c[0] === 'gh').map((c) => c.slice(0, 4))).toEqual([
    ['gh', 'pr', 'view', '82'],
    ['gh', 'pr', 'edit', '82'],
  ]);
  expect(m.calls.flat().join(' ')).not.toMatch(/push|commit|merge|reviewer|title/);
});
it('falls back to the REST endpoint when gh pr edit trips over retired classic projects', async () => {
  const m = mock();
  let sent = '';
  const command = m.io.command;
  const io = {
    ...m.io,
    command: async (cwd: string, bin: string, args: string[]) => {
      if (args[1] === 'edit') {
        m.calls.push([bin, ...args]);
        return {
          code: 1,
          timeout: false,
          output:
            'GraphQL: Projects (classic) is being deprecated (repository.pullRequest.projectCards)',
        };
      }
      if (args[0] === 'api') {
        m.calls.push([bin, ...args]);
        sent = readFileSync((args.find((a) => a.startsWith('body=@')) ?? '').slice(6), 'utf8');
        return { code: 0, timeout: false, output: '' };
      }
      return command(cwd, bin, args);
    },
  };
  const result = await updatePrBody({ cwd: temp, pr: '82', run: m.run }, io);
  expect(result.updated).toBe(true);
  expect(sent).toBe(result.body);
  const api = m.calls.find((c) => c[1] === 'api');
  expect(api?.slice(0, 5)).toEqual(['gh', 'api', '--method', 'PATCH', 'repos/owner/demo/pulls/82']);
  // Any other failure of gh pr edit is still a failure.
  const other = {
    ...m.io,
    command: async (cwd: string, bin: string, args: string[]) =>
      args[1] === 'edit'
        ? { code: 1, timeout: false, output: 'HTTP 403' }
        : command(cwd, bin, args),
  };
  await expect(updatePrBody({ cwd: temp, pr: '82', run: m.run }, other)).rejects.toThrow(
    'HTTP 403',
  );
});
it('rejects a mismatched branch, URL or verified commit before editing', async () => {
  for (const change of [
    (r: FixReport) => {
      r.branch = 'other';
    },
    (r: FixReport) => {
      r.prUrl = 'https://github.com/other/repo/pull/82';
    },
    (r: FixReport) => {
      r.head = 'stale';
    },
  ]) {
    const m = mock(),
      stored = structuredClone(m.report);
    change(stored);
    writeFileSync(m.run, JSON.stringify(stored));
    await expect(updatePrBody({ cwd: temp, pr: '82', run: m.run }, m.io)).rejects.toThrow(
      /match|differs/,
    );
    expect(m.calls.flat()).not.toContain('edit');
  }
});
it('never updates a PR from a failed or irreproducible run; --preview still renders it', async () => {
  for (const [change, reason] of [
    [
      (r: FixReport) => {
        r.verification.passed = false;
        r.verification.newErrors = [{ file: 'a.ts', line: 1, column: 1, code: 2322, message: 'x' }];
      },
      /PR description not updated: verification failed: 1 new type error/,
    ],
    [
      (r: FixReport) => {
        r.uptideDirty = true;
      },
      /PR description not updated: Uptide ran from a checkout with uncommitted changes/,
    ],
  ] as const) {
    const m = mock(),
      stored = structuredClone(m.report);
    change(stored);
    writeFileSync(m.run, JSON.stringify(stored));
    await expect(updatePrBody({ cwd: temp, pr: '82', run: m.run }, m.io)).rejects.toThrow(reason);
    expect(m.calls.flat()).not.toContain('edit');
    const preview = await updatePrBody({ cwd: temp, pr: '82', run: m.run, preview: true }, m.io);
    expect(preview.updated).toBe(false);
  }
  // The build rendering the body counts too.
  const m = mock();
  await expect(
    updatePrBody({ cwd: temp, pr: '82', run: m.run }, { ...m.io, tool: { uptideDirty: true } }),
  ).rejects.toThrow(/uncommitted changes/);
});
it("rejects a stored run whose repository is not the PR's, even with the same branch name", async () => {
  // Two repositories both have `uptide/zod-4.6.5`: a run file copied from one must not describe the other.
  const m = mock(),
    stored = structuredClone(m.report);
  stored.remote = 'https://github.com/someone/fixture';
  delete stored.prUrl;
  writeFileSync(m.run, JSON.stringify(stored));
  for (const preview of [true, false]) {
    await expect(updatePrBody({ cwd: temp, pr: '82', run: m.run, preview }, m.io)).rejects.toThrow(
      'stored run belongs to another repository',
    );
  }
  expect(m.calls.flat()).not.toContain('edit');
  stored.remote = 'https://github.com/owner/demo';
  writeFileSync(m.run, JSON.stringify(stored));
  expect((await updatePrBody({ cwd: temp, pr: '82', run: m.run }, m.io)).updated).toBe(true);
});
it('recovers legacy representative and accepted-agent diffs from read-only history', () => {
  const m = mock();
  delete m.report.head;
  m.report.sites = m.report.sites.filter((site) => site.outcome === 'mechanical').slice(0, 1);
  const s = m.report.sites[0];
  if (!s) throw new Error('missing fixture site');
  delete s.diff;
  const calls: string[][] = [];
  const enriched = retainedDiffs(m.report, (_cwd, ...args) => {
    calls.push(args);
    if (args[0] === 'log') return 'abc\tfix(zod): apply mechanical migrations';
    return args[1]?.includes('^')
      ? `${'\n'.repeat(s.finding.usage.line - 1)}.string({ required_error: "required" })`
      : `${'\n'.repeat(s.finding.usage.line - 1)}.string({ error: "required" })`;
  });
  expect(enriched.sites[0]?.diff).toContain('+ .string({ error: "required" })');
  expect(m.report.sites[0]?.diff).toBeUndefined();
  expect(calls.every((c) => ['log', 'show', 'diff'].includes(c[0] ?? ''))).toBe(true);
});

it("in a fork, reads and edits the pull request of the repository origin names, not the parent's", async () => {
  const m = mock();
  const git = m.io.git;
  m.io.git = (cwd, ...args) =>
    args[0] === 'remote' ? 'https://github.com/owner/demo.git' : git(cwd, ...args);
  await updatePrBody({ pr: '82', cwd: temp, run: m.run }, m.io);
  const view = m.calls.find((c) => c[1] === 'pr' && c[2] === 'view') as string[];
  const edit = m.calls.find((c) => c[1] === 'pr' && c[2] === 'edit') as string[];
  expect(view.slice(0, 6)).toEqual(['gh', 'pr', 'view', '82', '--repo', 'owner/demo']);
  expect(edit.slice(0, 6)).toEqual(['gh', 'pr', 'edit', '82', '--repo', 'owner/demo']);
});
