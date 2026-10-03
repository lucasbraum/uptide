import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const script = join(root, 'scripts/public-tree.mjs');

interface Result {
  files: number;
  denylist?: number;
  problems: string[];
}
/** The checker the export and CI run, on `dir`, with the denylist the environment gives it. */
function check(dir: string, env: Record<string, string> = {}): Result {
  const run = spawnSync('node', [script, dir, '--json'], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return JSON.parse(run.stdout) as Result;
}

/** A git repository with these files tracked, and the exclusion list this one uses. */
function tree(files: Record<string, string>, excluded: string[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), 'uptide-public-tree-'));
  const all = { 'scripts/public-export-exclude.txt': excluded.join('\n'), ...files };
  for (const [path, content] of Object.entries(all)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  return dir;
}

describe('public tree', () => {
  it('of this repository is clean: no private document, pointer or identifier', () => {
    const result = check(root);
    expect(result.problems).toEqual([]);
    expect(result.files).toBeGreaterThan(100);
    // The private repository carries the denylist; a public checkout gets it from the
    // environment in CI. Without either only names and pointers are checked here, and CI
    // requires the list where the repository is private.
    if (result.denylist !== undefined) expect(result.denylist).toBeGreaterThanOrEqual(5);
  });

  it('never accepts a tracked plan, even an excluded one', () => {
    const dir = tree({ 'docs/plan-next.md': 'x' }, ['docs/plan-next.md']);
    expect(check(dir).problems).toEqual([
      'docs/plan-next.md: a plan is pasted into briefs, never committed',
    ]);
  });

  it('flags a planning or audit document under any name, and a pointer to an excluded file', () => {
    const dir = tree(
      {
        'docs/roadmap-q4.md': 'x',
        'docs/internal-notes.md': 'private',
        'README.md': 'see docs/internal-notes.md',
      },
      ['docs/internal-notes.md'],
    );
    expect(check(dir).problems).toEqual([
      'docs/roadmap-q4.md: a private planning or audit document in the public tree',
      'README.md: points at internal-notes.md, which the export leaves out',
    ]);
  });

  it('flags a private identifier in a file or a path, without printing the line', () => {
    const dir = tree(
      {
        'src/client.ts': 'const repo = "AcmeCorp/api"; // ACME secret-line\n',
        'fixtures/acmecorp-run.json': '{}',
        'src/routes.ts': "app.get('/home/:id', show);\n",
        'src/paths.ts': "const home = '/Home/someone/code';\n",
        'private/denylist.txt': 'acmecorp',
      },
      ['private/'],
    );
    const { problems, denylist } = check(dir, { UPTIDE_PRIVATE_DENYLIST: 'acmecorp,/Home/' });
    expect(denylist).toBe(2);
    expect(problems).toEqual([
      'fixtures/acmecorp-run.json: the path contains the private identifier "acmecorp"',
      'src/client.ts: contains the private identifier "acmecorp"',
      'src/paths.ts: contains the private identifier "/Home/"',
    ]);
    expect(problems.join('\n')).not.toContain('secret-line');
  });
});

describe('public export', () => {
  const exporter = join(root, 'scripts/export-public.mjs');
  const commit = (dir: string): void => {
    execFileSync(
      'git',
      ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'private history'],
      { cwd: dir },
    );
  };
  // No --ref: the export is of `main`, the default.
  const run = (dir: string, out: string) =>
    spawnSync('node', [exporter, out], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        UPTIDE_PRIVATE_DENYLIST: 'acmecorp',
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@example.com',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@example.com',
      },
    });
  const manifest = JSON.stringify({ repository: { url: 'git+https://github.com/owner/tool.git' } });

  it('is the committed tree minus the excluded paths, in one fresh commit, never pushed', () => {
    const dir = tree(
      {
        'README.md': 'hello',
        'packages/cli/package.json': manifest,
        'docs/internal-notes.md': 'about acmecorp',
      },
      ['docs/internal-notes.md'],
    );
    commit(dir);
    writeFileSync(join(dir, 'untracked.txt'), 'acmecorp');
    const out = join(mkdtempSync(join(tmpdir(), 'uptide-export-')), 'public');
    const result = run(dir, out);
    expect(result.status, result.stderr).toBe(0);
    const files = execFileSync('git', ['ls-files'], { cwd: out, encoding: 'utf8' }).split('\n');
    expect(files.filter(Boolean).sort()).toEqual([
      'README.md',
      'packages/cli/package.json',
      'scripts/public-export-exclude.txt',
    ]);
    expect(execFileSync('git', ['log', '--format=%s'], { cwd: out, encoding: 'utf8' })).toBe(
      'Initial public release\n',
    );
    expect(execFileSync('git', ['remote'], { cwd: out, encoding: 'utf8' })).toBe('');
    expect(result.stdout).toMatch(/^exported main \([0-9a-f]{7}\) to /);
    expect(result.stdout).toContain('denylist (1 private identifiers): clean');
    expect(result.stdout).toContain('Nothing was created or pushed.');
    expect(result.stdout).toContain('gh repo create owner/tool --public');
  });

  it('fails, and prints no publish command, when a private identifier is in the export', () => {
    const dir = tree({
      'README.md': 'built for AcmeCorp',
      'packages/cli/package.json': manifest,
    });
    commit(dir);
    const out = join(mkdtempSync(join(tmpdir(), 'uptide-export-')), 'public');
    const result = run(dir, out);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('README.md: contains the private identifier "acmecorp"');
    expect(result.stdout).not.toContain('gh repo create');
  });

  it('refuses a directory inside the repository or one that is not empty', () => {
    const dir = tree({ 'README.md': 'hello', 'packages/cli/package.json': manifest });
    commit(dir);
    expect(run(dir, join(dir, 'public')).status).toBe(2);
    expect(run(dir, mkdtempSync(join(tmpdir(), 'uptide-export-full-'))).status).toBe(0);
    const full = mkdtempSync(join(tmpdir(), 'uptide-export-full-'));
    writeFileSync(join(full, 'mine.txt'), 'keep');
    expect(run(dir, full).status).toBe(2);
  });
});
