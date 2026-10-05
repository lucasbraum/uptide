import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const script = join(root, 'scripts/dco.mjs');

interface Result {
  commits: string[];
  problems: string[];
}
/** The checker CI runs, over everything `head` adds on top of `base`. */
function check(dir: string, base: string, head: string) {
  const run = spawnSync('node', [script, base, head, '--json'], { cwd: dir, encoding: 'utf8' });
  return {
    status: run.status,
    result: run.stdout ? (JSON.parse(run.stdout) as Result) : undefined,
  };
}

interface Commit {
  message: string;
  /** The author, when it differs from the repository's default identity. */
  author?: string;
}

/** A repository with a `main` branch and a `pr` branch carrying `commits` on top of it. */
function repo(commits: Commit[], base: Commit[] = [{ message: 'chore: root\n' }]): string {
  const dir = mkdtempSync(join(tmpdir(), 'uptide-dco-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Devin Example');
  git('config', 'user.email', 'devin@example.com');
  git('config', 'commit.gpgsign', 'false');
  let n = 0;
  const commit = ({ message, author }: Commit) => {
    n += 1;
    writeFileSync(join(dir, `file-${n}.txt`), `${n}\n`);
    git('add', '-A');
    git('commit', '-q', '-m', message, ...(author ? ['--author', author] : []));
  };
  for (const entry of base) commit(entry);
  git('checkout', '-q', '-b', 'pr');
  for (const entry of commits) commit(entry);
  return dir;
}

const signed = 'Signed-off-by: Devin Example <devin@example.com>';

describe('every commit in a pull request is signed off', () => {
  it('passes when every commit carries the author’s own sign-off', () => {
    const dir = repo([
      { message: `feat: one\n\n${signed}\n` },
      { message: `fix: two\n\nWhy it changed.\n\n${signed}\n` },
    ]);
    const { status, result } = check(dir, 'main', 'pr');
    expect(result?.problems).toEqual([]);
    expect(result?.commits).toHaveLength(2);
    expect(status).toBe(0);
  });

  it('names every commit that is missing the line, and only those', () => {
    const dir = repo([
      { message: `feat: signed\n\n${signed}\n` },
      { message: 'feat: forgotten\n' },
      { message: 'fix: also forgotten\n\nSigned off by me, honest.\n' },
    ]);
    const { status, result } = check(dir, 'main', 'pr');
    expect(status).toBe(1);
    expect(result?.problems).toEqual([
      expect.stringContaining('has no Signed-off-by line: feat: forgotten'),
      expect.stringContaining('has no Signed-off-by line: fix: also forgotten'),
    ]);
  });

  it('rejects a sign-off in somebody else’s name', () => {
    const dir = repo([
      { message: `feat: borrowed\n\n${signed}\n`, author: 'Someone Else <other@example.com>' },
    ]);
    const { status, result } = check(dir, 'main', 'pr');
    expect(status).toBe(1);
    expect(result?.problems).toEqual([
      expect.stringContaining('signed off by devin@example.com but authored by other@example.com'),
    ]);
  });

  it('accepts the author’s sign-off beside a co-author’s, in any case', () => {
    const dir = repo([
      {
        message: [
          'feat: together',
          '',
          'Co-authored-by: Someone Else <other@example.com>',
          'Signed-off-by: Someone Else <other@example.com>',
          'Signed-off-by: Devin Example <DEVIN@Example.com>',
          '',
        ].join('\n'),
      },
    ]);
    expect(check(dir, 'main', 'pr').result?.problems).toEqual([]);
  });

  it('checks the whole range, however far the base branch has moved on since', () => {
    const dir = repo([{ message: 'feat: forgotten\n' }, { message: `fix: fine\n\n${signed}\n` }]);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    // main gains commits with no sign-off after the branch forked: not this branch's doing.
    git('checkout', '-q', 'main');
    git('commit', '-q', '--allow-empty', '-m', 'chore: unrelated, unsigned\n');
    git('commit', '-q', '--allow-empty', '-m', 'chore: another\n');
    git('checkout', '-q', 'pr');
    const { status, result } = check(dir, 'main', 'pr');
    expect(result?.commits).toHaveLength(2);
    expect(result?.problems).toEqual([
      expect.stringContaining('has no Signed-off-by line: feat: forgotten'),
    ]);
    expect(status).toBe(1);
  });

  it('holds a merge commit to the same rule', () => {
    const dir = repo([{ message: `feat: one\n\n${signed}\n` }]);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    git('checkout', '-q', 'main');
    git('commit', '-q', '--allow-empty', '-m', `chore: base\n\n${signed}\n`);
    git('checkout', '-q', 'pr');
    git('merge', '-q', '--no-ff', '-m', 'chore: merge main\n', 'main');
    const { status, result } = check(dir, 'main', 'pr');
    expect(status).toBe(1);
    expect(result?.problems).toEqual([
      expect.stringContaining('has no Signed-off-by line: chore: merge main'),
    ]);
  });

  it('passes a pull request that adds nothing', () => {
    const dir = repo([]);
    const { status, result } = check(dir, 'main', 'pr');
    expect(result).toEqual({ commits: [], problems: [] });
    expect(status).toBe(0);
  });

  it('tells a contributor what to run, naming the branch they are merging into', () => {
    const dir = repo([{ message: 'feat: forgotten\n' }]);
    const run = spawnSync('node', [script, 'main', 'pr'], { cwd: dir, encoding: 'utf8' });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('git rebase --signoff main');
    expect(run.stdout).toContain('git push --force-with-lease');
    expect(run.stdout).toContain('CONTRIBUTING.md');
  });

  it('names the branch CI tells it to, not the ref CI fetched for itself', () => {
    const dir = repo([{ message: 'feat: forgotten\n' }]);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    // What the workflow does: the range comes from refs it fetched, which nobody rebases
    // onto, so the message has to name the base branch instead.
    git('update-ref', 'refs/uptide/base', 'main');
    git('update-ref', 'refs/uptide/pr-head', 'pr');
    const run = spawnSync(
      'node',
      [script, 'refs/uptide/base', 'refs/uptide/pr-head', '--base-name=origin/main'],
      { cwd: dir, encoding: 'utf8' },
    );
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('git rebase --signoff origin/main');
    expect(run.stdout).not.toContain('refs/uptide/base');
  });

  it('refuses to report success when it was given no range', () => {
    const run = spawnSync('node', [script], { cwd: root, encoding: 'utf8' });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('usage:');
  });
});
