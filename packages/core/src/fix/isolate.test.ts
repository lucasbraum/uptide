import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { version } from '../version.js';
import {
  changedSince,
  cleanRuns,
  isolatedFix,
  isolatedVerify,
  removeRun,
  runsRoot,
  snapshot,
  storedRunFile,
} from './isolate.js';
import { openPr } from './pr.js';
import { command, git, quietEnv } from './process.js';
import { zodFixture } from './test-fixture.js';

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'uptide-isolate-')));
// Clones made by these tests live under the scratch directory, not in the machine's temporary root.
process.env.UPTIDE_RUNS_DIR = join(scratch, 'runs');
afterAll(() => {
  delete process.env.UPTIDE_RUNS_DIR;
  rmSync(scratch, { recursive: true, force: true });
});
const TOOL = { uptideVersion: version, uptideCommit: 'a'.repeat(40), uptideDirty: false };
const hook = (root: string, name: string, script: string) => {
  mkdirSync(join(root, '.git/hooks'), { recursive: true });
  writeFileSync(join(root, '.git/hooks', name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
};

describe('commands run without lifecycle scripts or git hooks', () => {
  it('turns scripts and hook installers off for every package manager', () => {
    expect(quietEnv()).toMatchObject({
      npm_config_ignore_scripts: 'true',
      pnpm_config_ignore_scripts: 'true',
      pnpm_config_verify_deps_before_run: 'false',
      YARN_ENABLE_SCRIPTS: 'false',
      SKIP_SIMPLE_GIT_HOOKS: '1',
      HUSKY: '0',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
    });
  });

  it('does not run a repository hook for a git command a script starts', async () => {
    const { root } = zodFixture(scratch);
    hook(root, 'pre-commit', 'touch HOOK_RAN');
    writeFileSync(join(root, 'note.txt'), 'x');
    const result = await command(root, '/bin/sh', [
      '-c',
      'git add note.txt && git commit -qm note',
    ]);
    expect(result.code).toBe(0);
    expect(existsSync(join(root, 'HOOK_RAN'))).toBe(false);
    // The same commit by hand, outside uptide, does run it: the hook itself works.
    writeFileSync(join(root, 'note.txt'), 'y');
    execFileSync('git', ['-C', root, 'commit', '-qam', 'again']);
    expect(existsSync(join(root, 'HOOK_RAN'))).toBe(true);
  });
});

describe('fix runs in a private clone', () => {
  it('leaves the checkout exactly as it was and hands back a branch and a stored run', async () => {
    const { root, services } = zodFixture(scratch);
    hook(root, 'pre-push', 'exit 1');
    git(root, 'config', 'uptide.test', 'kept');
    const before = snapshot(root);
    const where: string[] = [];
    const tests = services.tests;
    services.tests = async (dir, ...rest) => {
      where.push(dir);
      // What a hook installer in a `prepare` script does: write into the repository it runs in.
      mkdirSync(join(dir, '.git/hooks'), { recursive: true });
      writeFileSync(join(dir, '.git/hooks/pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
      execFileSync('git', ['-C', dir, 'config', 'core.somebody', 'was-here']);
      return tests(dir, ...rest);
    };
    const report = await isolatedFix({ cwd: root, only: 'zod', tool: TOOL, keep: true }, services);
    expect(report.clone).toEqual({
      path: report.repo,
      kept: true,
      reason: 'kept on request (--keep)',
    });
    // Nothing happened in the checkout: same branch, same files, same hooks, same config.
    expect(changedSince(root, before)).toEqual([]);
    expect(report.sourceChanged).toBeUndefined();
    expect(git(root, 'status', '--porcelain', '--untracked-files=all')).toBe('');
    expect(existsSync(join(root, '.uptide'))).toBe(false);
    expect(existsSync(join(root, '.git/hooks/pre-commit'))).toBe(false);
    expect(readFileSync(join(root, 'index.ts'), 'utf8')).toContain('required_error');
    // Everything ran somewhere else, and that is where the hook installer wrote.
    expect(report.source).toBe(root);
    expect(report.repo).not.toBe(root);
    expect(new Set(where)).toEqual(new Set([report.repo]));
    expect(existsSync(join(report.repo, '.git/hooks/pre-commit'))).toBe(true);
    // The branch is a ref in the repository, not checked out, at the verified commit.
    expect(git(root, 'branch', '--show-current')).toBe(before.branch);
    expect(git(root, 'rev-parse', 'uptide/zod-4.6.5')).toBe(report.head);
    expect(git(root, 'show', 'uptide/zod-4.6.5:index.ts')).toContain('error:');
    // The run is kept inside .git, where git status never looks.
    const stored = storedRunFile(root, 'uptide/zod-4.6.5');
    expect(stored).toBe(join(root, '.git/uptide/uptide__zod-4.6.5/report.json'));
    expect(JSON.parse(readFileSync(stored as string, 'utf8')).head).toBe(report.head);
    expect(report.prBody).toBe(join(root, '.git/uptide/uptide__zod-4.6.5/pr-body.md'));
    expect(readFileSync(report.prBody, 'utf8')).toContain('## Upgrade zod');
    expect(report.verification.passed).toBe(true);
  }, 30000);

  it('branches from the remote default branch, never from unpushed local commits, and says so', async () => {
    const { root, services } = zodFixture(scratch);
    const origin = join(mkdtempSync(join(scratch, 'origin-')), 'origin.git');
    git(root, 'init', '--bare', origin);
    git(root, 'remote', 'add', 'origin', origin);
    git(root, 'push', '--quiet', '-u', 'origin', 'HEAD');
    git(root, 'remote', 'set-head', 'origin', '--auto');
    const pushed = git(root, 'rev-parse', 'HEAD');
    // A local commit the remote does not have: not part of the migration.
    writeFileSync(join(root, 'local-only.txt'), 'x');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'local only');
    const report = await isolatedFix({ cwd: root, only: 'zod', tool: TOOL }, services);
    expect(report.base).toBe(git(root, 'branch', '--show-current'));
    expect(git(root, 'merge-base', 'uptide/zod-4.6.5', 'HEAD')).toBe(pushed);
    expect(git(root, 'show', 'uptide/zod-4.6.5', '--stat', '--format=')).not.toContain(
      'local-only',
    );
    expect(report.notes.join('\n')).toMatch(
      /has 1 commit not on origin\/\w+; the migration branches from origin\/\w+ and does not include them/,
    );
    // A --pr run from a dirty Uptide build is refused before any clone exists.
    const runs = readdirSync(runsRoot()).length;
    await expect(
      isolatedFix(
        { cwd: root, only: 'zod', pr: true, tool: { ...TOOL, uptideDirty: true } },
        services,
      ),
    ).rejects.toThrow('refuses to run from an Uptide checkout with uncommitted changes');
    expect(readdirSync(runsRoot()).length).toBe(runs);
  }, 30000);

  it('lands the verified run before publishing, so a failed publish can be retried with `uptide pr`', async () => {
    const { root, services } = zodFixture(scratch);
    const origin = join(mkdtempSync(join(scratch, 'origin-')), 'origin.git');
    git(root, 'init', '--bare', origin);
    git(root, 'remote', 'add', 'origin', origin);
    git(root, 'push', '--quiet', '-u', 'origin', 'HEAD');
    // The publish step fails the way a push or `gh` does: after everything else succeeded.
    const seen: { branch: boolean; stored: boolean; cwd?: string }[] = [];
    services.publish = async (result, options) => {
      seen.push({
        branch: git(root, 'rev-parse', '--verify', result.branch) === result.head,
        stored: existsSync(storedRunFile(root, result.branch) ?? ''),
        ...(options.cwd ? { cwd: options.cwd } : {}),
      });
      result.publication = { refused: [], failed: 'gh pr create failed: HTTP 502' };
      result.notes.push('PR not opened: gh pr create failed: HTTP 502.');
    };
    const report = await isolatedFix(
      { cwd: root, only: 'zod', pr: true, yes: true, tool: TOOL },
      services,
    );
    // When publishing started, the branch and the stored run were already in the repository,
    // and the publish ran from there.
    expect(seen).toEqual([{ branch: true, stored: true, cwd: root }]);
    expect(report.verification.passed).toBe(true);
    expect(report.publication?.failed).toBe('gh pr create failed: HTTP 502');
    expect(report.clone?.kept).toBe(false);
    const stored = JSON.parse(readFileSync(storedRunFile(root, report.branch) as string, 'utf8'));
    expect(stored.publication.failed).toBe('gh pr create failed: HTTP 502');
    expect(stored.head).toBe(git(root, 'rev-parse', report.branch));
    // `uptide pr` then needs nothing but the repository: the stored run and the branch.
    const calls: string[][] = [];
    const { url } = await openPr({ cwd: root, branch: report.branch, yes: true }, () => {}, {
      git: (cwd, ...args) => {
        calls.push(['git', ...args]);
        if (args[0] === 'remote') return 'https://github.com/me/repo.git';
        if (args[0] === 'push') return '';
        return git(cwd, ...args);
      },
      command: async (_cwd, _bin, args) => ({
        code: 0,
        timeout: false,
        output:
          args[0] === 'repo'
            ? JSON.stringify({ defaultBranchRef: { name: 'main' }, nameWithOwner: 'me/repo' })
            : args[0] === 'pr' && args[1] === 'list'
              ? '[]'
              : args[1] === 'list'
                ? '[{"name":"uptide"}]'
                : 'https://github.com/me/repo/pull/12',
      }),
      print: () => {},
    });
    expect(url).toBe('https://github.com/me/repo/pull/12');
    expect(calls).toContainEqual([
      'git',
      'push',
      '--set-upstream',
      'origin',
      `${report.branch}:${report.branch}`,
    ]);
  }, 30000);

  it('runs a project that lives below the git top level, and refuses a run from inside a workspace', async () => {
    // A repository whose root is not a JavaScript project: the app is in frontend/.
    const { root: fixture, services } = zodFixture(scratch);
    rmSync(join(fixture, '.git'), { recursive: true, force: true });
    const top = realpathSync(mkdtempSync(join(scratch, 'mono-')));
    const project = join(top, 'frontend');
    renameSync(fixture, project);
    writeFileSync(join(top, 'README.md'), 'backend + frontend\n');
    git(top, 'init');
    git(top, 'config', 'user.email', 'test@example.test');
    git(top, 'config', 'user.name', 'Test');
    git(top, 'add', '.');
    git(top, 'commit', '-m', 'baseline');
    const report = await isolatedFix({ cwd: project, only: 'zod', tool: TOOL }, services);
    expect(report.verification.passed).toBe(true);
    expect(report.source).toBe(top);
    expect(git(top, 'status', '--porcelain', '--untracked-files=all')).toBe('');
    expect(git(top, 'show', 'uptide/zod-4.6.5:frontend/index.ts')).toContain('error:');
    expect(git(top, 'show', 'uptide/zod-4.6.5:frontend/package.json')).toContain('4.6.5');
    expect(storedRunFile(project, 'uptide/zod-4.6.5')).toBe(
      join(top, '.git/uptide/uptide__zod-4.6.5/report.json'),
    );
    // Inside a workspace of the project is not the project.
    mkdirSync(join(project, 'packages/api'), { recursive: true });
    writeFileSync(join(project, 'packages/api/package.json'), '{"name":"api"}');
    git(top, 'add', '.');
    git(top, 'commit', '-q', '-m', 'workspace');
    await expect(
      isolatedFix({ cwd: join(project, 'packages/api'), only: 'zod', tool: TOOL }, services),
    ).rejects.toThrow(`run fix at the project root, ${project}`);
  }, 30000);

  it('refuses a dirty checkout, and reports a checkout that changed during the run', async () => {
    const dirty = zodFixture(scratch);
    writeFileSync(join(dirty.root, 'wip.txt'), 'x');
    await expect(isolatedFix({ cwd: dirty.root, only: 'zod' }, dirty.services)).rejects.toThrow(
      'clean working tree',
    );
    const { root, services } = zodFixture(scratch);
    const tests = services.tests;
    services.tests = async (dir, ...rest) => {
      // Something outside uptide's control touches the real checkout while the run is going.
      writeFileSync(join(root, 'surprise.txt'), 'x');
      return tests(dir, ...rest);
    };
    const report = await isolatedFix({ cwd: root, only: 'zod', tool: TOOL }, services);
    expect(report.sourceChanged).toEqual(['the working tree has different changes']);
    expect(report.notes.at(-1)).toMatch(/^Your checkout changed during the run/);
  }, 30000);
});

describe('verify runs in a private clone and only ever adds commits', () => {
  const style = {
    format: async (dir: string, files: string[]) => {
      for (const file of files)
        writeFileSync(join(dir, file), `${readFileSync(join(dir, file), 'utf8')}// formatted\n`);
      return ['biome'];
    },
    lint: async () => [],
  };
  async function migrated() {
    const { root, services } = zodFixture(scratch);
    const origin = join(mkdtempSync(join(scratch, 'origin-')), 'origin.git');
    git(root, 'init', '--bare', origin);
    git(root, 'remote', 'add', 'origin', origin);
    const first = await isolatedFix({ cwd: root, only: 'zod', tool: TOOL }, services);
    git(root, 'push', '--quiet', 'origin', 'uptide/zod-4.6.5');
    return { root, origin, services: { ...services, ...style }, first };
  }

  it('fast-forwards a branch that is not checked out, without touching the working tree', async () => {
    const { root, services, first } = await migrated();
    const before = snapshot(root);
    const again = await isolatedVerify(
      { cwd: root, branch: 'uptide/zod-4.6.5', tool: TOOL },
      services,
    );
    expect(changedSince(root, before)).toEqual([]);
    expect(again.verification.passed).toBe(true);
    expect(again.head).not.toBe(first.head);
    // One commit on top of the old head; the old head is still its parent.
    expect(git(root, 'rev-parse', 'uptide/zod-4.6.5')).toBe(again.head);
    expect(git(root, 'rev-parse', 'uptide/zod-4.6.5~1')).toBe(first.head);
    expect(
      JSON.parse(readFileSync(storedRunFile(root, 'uptide/zod-4.6.5') as string, 'utf8')).head,
    ).toBe(again.head);
  }, 40000);

  it('removes the clone once the commits are in the repository', async () => {
    const { root, services } = await migrated();
    const again = await isolatedVerify(
      { cwd: root, branch: 'uptide/zod-4.6.5', tool: TOOL },
      services,
    );
    expect(again.clone?.kept).toBe(false);
    expect(existsSync(again.clone?.path ?? '')).toBe(false);
    // The run now points at the repository that has the commits.
    expect(again.repo).toBe(root);
    expect(git(root, 'rev-parse', 'uptide/zod-4.6.5')).toBe(again.head);
  }, 40000);

  it('leaves a checked-out branch alone and keeps the new commits in the clone', async () => {
    const { root, services, first } = await migrated();
    git(root, 'switch', '--quiet', 'uptide/zod-4.6.5');
    const before = snapshot(root);
    const again = await isolatedVerify({ cwd: root, tool: TOOL }, services);
    expect(changedSince(root, before)).toEqual([]);
    expect(git(root, 'rev-parse', 'HEAD')).toBe(first.head);
    // The clone is the only place the new commits exist, so it stays, and says why.
    expect(again.clone).toEqual({
      path: again.repo,
      kept: true,
      reason: 'it holds commits that are not in your repository or on the remote yet',
    });
    expect(git(again.repo, 'rev-parse', 'HEAD')).toBe(again.head);
    expect(again.notes.join('\n')).toContain(
      `uptide/zod-4.6.5 is checked out in your repository, so it was not moved; the new commits are in ${again.repo}.`,
    );
  }, 40000);

  it('pushes from the clone only with --yes, and only as a fast-forward', async () => {
    const { root, origin, services, first } = await migrated();
    await expect(
      isolatedVerify({ cwd: root, branch: 'uptide/zod-4.6.5', push: true, tool: TOOL }, services),
    ).rejects.toThrow(
      /--push would push new commits to uptide\/zod-4\.6\.5 on origin \(fast-forward only\); add --yes/,
    );
    expect(git(origin, 'rev-parse', 'uptide/zod-4.6.5')).toBe(first.head);
    const pushed = await isolatedVerify(
      { cwd: root, branch: 'uptide/zod-4.6.5', push: true, yes: true, tool: TOOL },
      services,
    );
    expect(git(origin, 'rev-parse', 'uptide/zod-4.6.5')).toBe(pushed.head);
    expect(git(origin, 'rev-parse', 'uptide/zod-4.6.5~1')).toBe(first.head);
    // Pushed: the clone has done its job and is gone.
    expect(pushed.clone?.kept).toBe(false);
    expect(existsSync(pushed.clone?.path ?? '')).toBe(false);
    expect(pushed.notes.at(-1)).toMatch(
      /^Pushed [0-9a-f]{8} to origin\/uptide\/zod-4\.6\.5 \(fast-forward\)\.$/,
    );
    // The remote moved on in the meantime, to a commit the branch does not contain: a
    // non-fast-forward push fails instead of overwriting it.
    const elsewhere = git(root, 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'someone else');
    git(root, 'push', '--quiet', '--force', 'origin', `${elsewhere}:refs/heads/uptide/zod-4.6.5`);
    const refused = await isolatedVerify(
      { cwd: root, branch: 'uptide/zod-4.6.5', push: true, yes: true, tool: TOOL },
      services,
    ).catch((error: Error) => error);
    expect(refused).toBeInstanceOf(Error);
    // A run that threw is a failed run: its clone is kept and the error says where.
    const kept = /Temporary clone kept: (.+)$/m.exec((refused as Error).message)?.[1] ?? '';
    expect(existsSync(kept)).toBe(true);
    expect(git(origin, 'rev-parse', 'uptide/zod-4.6.5')).toBe(elsewhere);
  }, 60000);

  it('says so when the branch has no stored run', async () => {
    const { root } = zodFixture(scratch);
    await expect(isolatedVerify({ cwd: root, branch: 'uptide/zod-4.6.5' })).rejects.toThrow(
      'no stored migration run for uptide/zod-4.6.5 in this repository',
    );
  });
});

describe("temporary clones are cleaned up, and only uptide's own", () => {
  it('removes the clone after a run that verified, and keeps it when the run did not', async () => {
    const ok = zodFixture(scratch);
    const done = await isolatedFix({ cwd: ok.root, only: 'zod', tool: TOOL }, ok.services);
    expect(done.verification.passed).toBe(true);
    expect(done.clone?.kept).toBe(false);
    expect(existsSync(done.clone?.path ?? '')).toBe(false);
    expect(done.repo).toBe(ok.root);
    expect(done.clone?.path.startsWith(`${runsRoot()}/run-`)).toBe(true);
    // The stored run and its body are still there: they live in the repository's .git.
    expect(existsSync(done.prBody)).toBe(true);

    const bad = zodFixture(scratch);
    let calls = 0;
    bad.services.diagnostics = () =>
      ++calls === 1 ? [] : [{ file: 'index.ts', line: 1, column: 1, code: 1, message: 'new' }];
    const failed = await isolatedFix({ cwd: bad.root, only: 'zod', tool: TOOL }, bad.services);
    expect(failed.verification.passed).toBe(false);
    expect(failed.clone).toEqual({
      path: failed.repo,
      kept: true,
      reason: 'the run did not verify',
    });
    expect(existsSync(failed.repo)).toBe(true);
  }, 40000);

  it('never deletes anything outside its temporary root, or anything it did not create', () => {
    const root = mkdtempSync(join(scratch, 'runs-'));
    const mine = join(root, 'run-abc');
    mkdirSync(join(mine, 'repo'), { recursive: true });
    writeFileSync(join(mine, '.uptide-run'), JSON.stringify({ created: new Date().toISOString() }));
    // Named like a run but without the marker; a marker but not named like a run; and a
    // directory outside the root that has both.
    const unmarked = join(root, 'run-nomarker');
    mkdirSync(unmarked);
    const misnamed = join(root, 'project');
    mkdirSync(misnamed);
    writeFileSync(join(misnamed, '.uptide-run'), '{}');
    const outside = join(mkdtempSync(join(scratch, 'elsewhere-')), 'run-xyz');
    mkdirSync(join(outside, 'repo'), { recursive: true });
    writeFileSync(join(outside, '.uptide-run'), '{}');
    for (const path of [unmarked, misnamed, outside, join(outside, 'repo'), root, scratch, '/'])
      expect(removeRun(path, root), path).toBe(false);
    for (const path of [unmarked, misnamed, outside, root]) expect(existsSync(path)).toBe(true);
    // Its own run, given as the run or as its repo directory.
    expect(removeRun(join(mine, 'repo'), root)).toBe(true);
    expect(existsSync(mine)).toBe(false);
  });

  it('cleans kept clones older than the limit and leaves the rest', () => {
    const root = mkdtempSync(join(scratch, 'runs-'));
    const now = Date.parse('2026-10-10T00:00:00.000Z');
    const run = (name: string, created: string) => {
      mkdirSync(join(root, name, 'repo'), { recursive: true });
      writeFileSync(join(root, name, '.uptide-run'), JSON.stringify({ created }));
      return join(root, name);
    };
    const old = run('run-old', '2026-10-01T00:00:00.000Z');
    const recent = run('run-recent', '2026-10-08T00:00:00.000Z');
    mkdirSync(join(root, 'run-foreign'));
    writeFileSync(join(root, 'notes.txt'), 'not a run');
    expect(cleanRuns({ root, now })).toEqual({ removed: [old], kept: [recent] });
    expect(existsSync(old)).toBe(false);
    expect(existsSync(recent)).toBe(true);
    // What uptide did not create is not even counted.
    expect(existsSync(join(root, 'run-foreign'))).toBe(true);
    expect(existsSync(join(root, 'notes.txt'))).toBe(true);
    expect(cleanRuns({ root, now, days: 1 })).toEqual({ removed: [recent], kept: [] });
    expect(cleanRuns({ root: join(root, 'missing'), now })).toEqual({ removed: [], kept: [] });
  });
});
