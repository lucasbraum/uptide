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
