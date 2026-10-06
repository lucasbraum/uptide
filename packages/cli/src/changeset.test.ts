// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these are GitHub Actions expressions, quoted as written in the workflows.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const script = join(root, 'scripts/changeset-required.mjs');
type File = { status: string; path: string };
type Verdict = (input: { files: File[]; labels?: string[]; author?: string }) => {
  ok: boolean;
  reason: string;
};
const { changesetVerdict } = (await import(script)) as { changesetVerdict: Verdict };

const code = { status: 'M', path: 'packages/core/src/list/list.ts' };
const changeset = { status: 'A', path: '.changeset/quiet-owls-sing.md' };

describe('a pull request that changes packages/** comes with a changeset', () => {
  it('fails without one, and says what to do', () => {
    const verdict = changesetVerdict({ files: [code], author: 'lucas' });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('pnpm changeset');
    expect(verdict.reason).toContain('no-changeset');
  });

  it('passes with a changeset, the no-changeset label, or nothing under packages/', () => {
    expect(changesetVerdict({ files: [code, changeset], author: 'lucas' }).ok).toBe(true);
    expect(changesetVerdict({ files: [code], labels: ['no-changeset'], author: 'lucas' }).ok).toBe(
      true,
    );
    expect(
      changesetVerdict({ files: [{ status: 'M', path: 'docs/cli.md' }], author: 'lucas' }).ok,
    ).toBe(true);
  });

  it('counts neither the changesets README nor a deleted changeset', () => {
    for (const other of [
      { status: 'M', path: '.changeset/README.md' },
      { status: 'D', path: '.changeset/quiet-owls-sing.md' },
      { status: 'M', path: '.changeset/config.json' },
    ])
      expect(changesetVerdict({ files: [code, other], author: 'lucas' }).ok).toBe(false);
  });

  it('exempts Dependabot and the release app, by the opener GitHub records', () => {
    // The Version Packages pull request deletes the changesets it consumes.
    const version = [code, { status: 'D', path: '.changeset/quiet-owls-sing.md' }];
    expect(changesetVerdict({ files: version, author: 'uptide-release[bot]' }).ok).toBe(true);
    expect(changesetVerdict({ files: [code], author: 'dependabot[bot]' }).ok).toBe(true);
    for (const author of ['github-actions[bot]', 'uptide-release', 'dependabot'])
      expect(changesetVerdict({ files: [code], author }).ok).toBe(false);
  });

  it('reads the range and the labels as the workflow passes them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uptide-changeset-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    const write = (path: string) => {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), `${path}\n`);
    };
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Devin Example');
    git('config', 'user.email', 'devin@example.com');
    git('config', 'commit.gpgsign', 'false');
    write('README.md');
    git('add', '-A');
    git('commit', '-q', '-m', 'root');
    git('checkout', '-q', '-b', 'pr');
    write('packages/cli/src/cli.ts');
    git('add', '-A');
    git('commit', '-q', '-m', 'change');
    const run = (env: Record<string, string>) =>
      spawnSync('node', [script, 'main', 'pr'], {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, ...env },
      });
    const missing = run({ PR_AUTHOR: 'lucas', LABELS: '[]' });
    expect(missing.status).toBe(1);
    expect(missing.stdout).toContain('::error title=Changeset::');
    expect(run({ PR_AUTHOR: 'lucas', LABELS: '["no-changeset"]' }).status).toBe(0);
    write('.changeset/quiet-owls-sing.md');
    git('add', '-A');
    git('commit', '-q', '-m', 'changeset');
    expect(run({ PR_AUTHOR: 'lucas', LABELS: '[]' }).status).toBe(0);
  });

  it('reruns when a label changes, and passes the labels and opener the script reads', () => {
    const workflow = parse(
      execFileSync('cat', [join(root, '.github/workflows/changeset.yml')], { encoding: 'utf8' }),
    );
    expect(workflow.on.pull_request.types).toEqual([
      'opened',
      'synchronize',
      'reopened',
      'labeled',
      'unlabeled',
    ]);
    expect(workflow.permissions).toEqual({ contents: 'read' });
    const step = workflow.jobs.changeset.steps.at(-1);
    expect(step.env.LABELS).toBe('${{ toJSON(github.event.pull_request.labels.*.name) }}');
    expect(step.env.PR_AUTHOR).toBe('${{ github.event.pull_request.user.login }}');
    expect(step.run).toContain(
      'node scripts/changeset-required.mjs refs/uptide/base refs/uptide/pr-head',
    );
  });
});
