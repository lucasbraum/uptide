import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
/** The checker CI runs, on `dir`; `list` replaces whatever denylist the environment has. */
function check(dir: string, list?: string, flags: string[] = []) {
  const env: Record<string, string | undefined> = { ...process.env };
  if (list !== undefined) env.UPTIDE_PRIVATE_DENYLIST = list;
  const run = spawnSync('node', [script, dir, '--json', ...flags], { encoding: 'utf8', env });
  return {
    status: run.status,
    result: run.stdout ? (JSON.parse(run.stdout) as Result) : undefined,
  };
}

/** A git repository with these files tracked. */
function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'uptide-public-tree-'));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  return dir;
}

describe('private material stays out of this repository', () => {
  it('this repository is clean, against the denylist CI provides when there is one', () => {
    const { result } = check(root);
    expect(result?.problems).toEqual([]);
    expect(result?.files).toBeGreaterThan(100);
  });

  it('flags a planning or audit document under any name', () => {
    const dir = tree({ 'docs/roadmap-q4.md': 'x', 'docs/plan-next.md': 'x', 'README.md': 'x' });
    expect(check(dir, '').result?.problems).toEqual([
      'docs/plan-next.md: a private planning or audit document does not belong here',
      'docs/roadmap-q4.md: a private planning or audit document does not belong here',
    ]);
  });

  it('flags a private identifier in a file or a path, without printing the line', () => {
    const dir = tree({
      'src/client.ts': 'const repo = "AcmeCorp/api"; // ACME secret-line\n',
      'fixtures/acmecorp-run.json': '{}',
      'src/routes.ts': "app.get('/home/:id', show);\n",
      'src/paths.ts': "const home = '/Home/someone/code';\n",
    });
    const { result, status } = check(dir, 'acmecorp,/Home/');
    expect(status).toBe(1);
    expect(result?.denylist).toBe(2);
    expect(result?.problems).toEqual([
      'fixtures/acmecorp-run.json: the path contains the private identifier "acmecorp"',
      'src/client.ts: contains the private identifier "acmecorp"',
      'src/paths.ts: contains the private identifier "/Home/"',
    ]);
    expect(result?.problems.join('\n')).not.toContain('secret-line');
  });

  it('refuses to pass without a denylist where one is required', () => {
    const dir = tree({ 'README.md': 'x' });
    expect(check(dir, '', ['--require-denylist']).status).toBe(2);
    expect(check(dir, 'acmecorp', ['--require-denylist']).status).toBe(0);
  });
});

describe('the CI step that runs it', () => {
  /** The `run: |` block of the "No private material" step, exactly as CI runs it. */
  const step = (() => {
    const lines = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8').split('\n');
    const start = lines.findIndex((line) => line.trim() === '- name: No private material');
    const run = lines.findIndex((line, i) => i > start && line.trim() === 'run: |');
    const indent = (line: string) => line.length - line.trimStart().length;
    const body: string[] = [];
    for (const line of lines.slice(run + 1)) {
      if (line.trim() && indent(line) <= indent(lines[run] as string)) break;
      body.push(line.slice(indent(lines[run] as string) + 2));
    }
    return body.join('\n');
  })();
  const repo = 'uptide-dev/uptide';
  /** The step under one event; the denylist term is one this repository never contains. */
  function ci(env: { EVENT: string; HEAD_REPO?: string; PR_AUTHOR?: string; secret: boolean }) {
    const run = spawnSync('bash', ['-e', '-c', step], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        EVENT: env.EVENT,
        HEAD_REPO: env.HEAD_REPO ?? '',
        REPO: repo,
        PR_AUTHOR: env.PR_AUTHOR ?? '',
        // Built here, so this file does not contain it either.
        UPTIDE_PRIVATE_DENYLIST: env.secret ? ['zz', 'absent', 'zz'].join('-') : '',
      },
    });
    return {
      status: run.status,
      notice: run.stdout.includes('::notice title=No private material::'),
      scanned: run.stdout.includes('1 private identifiers'),
    };
  }
  const ours = { EVENT: 'pull_request', HEAD_REPO: repo };

  it('scans with the denylist on a push to main, and fails without it', () => {
    expect(ci({ EVENT: 'push', secret: true })).toEqual({
      status: 0,
      notice: false,
      scanned: true,
    });
    expect(ci({ EVENT: 'push', secret: false }).status).toBe(2);
  });

  it("skips the identifier scan with a notice only on Dependabot's own pull request without it", () => {
    expect(ci({ ...ours, PR_AUTHOR: 'dependabot[bot]', secret: false })).toEqual({
      status: 0,
      notice: true,
      scanned: false,
    });
    // Given the denylist anyway, it is used.
    expect(ci({ ...ours, PR_AUTHOR: 'dependabot[bot]', secret: true })).toEqual({
      status: 0,
      notice: false,
      scanned: true,
    });
  });

  it('still fails a missing denylist on any other pull request from this repository', () => {
    for (const author of ['lucas', 'github-actions[bot]', 'dependabot', ''])
      expect([author, ci({ ...ours, PR_AUTHOR: author, secret: false }).status]).toEqual([
        author,
        2,
      ]);
  });

  it('checks only document names on a fork, which has no secrets', () => {
    expect(
      ci({
        EVENT: 'pull_request',
        HEAD_REPO: 'someone/uptide',
        PR_AUTHOR: 'someone',
        secret: false,
      }),
    ).toEqual({ status: 0, notice: false, scanned: false });
  });
});
