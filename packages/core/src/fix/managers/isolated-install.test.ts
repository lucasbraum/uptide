import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { command, git } from '../process.js';
import { isolatedUpgrade } from './isolated-install.js';
import { packageManager } from './manager.js';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});
function fixture(project = '.') {
  const top = mkdtempSync(join(tmpdir(), 'install-isolation-test-'));
  roots.push(top);
  const root = join(top, project);
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    '{"name":"consumer","dependencies":{"target":"^1.0.0"}}\n',
  );
  writeFileSync(join(root, 'package-lock.json'), '{"lockfileVersion":3,"packages":{}}\n');
  writeFileSync(join(root, '.gitignore'), 'node_modules\n');
  git(top, 'init');
  git(top, 'add', '.');
  git(
    top,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.test',
    'commit',
    '-m',
    'baseline',
  );
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  writeFileSync(join(root, 'node_modules/baseline'), 'old');
  writeFileSync(
    join(root, 'package.json'),
    '{"name":"consumer","dependencies":{"target":"^2.0.0"}}\n',
  );
  return root;
}
const upgrade = { name: 'target', version: '2.0.0', files: ['package.json'], workspaces: ['.'] };
it('installs in a detached worktree, promotes lockfile bytes unchanged and cleans up', async () => {
  const root = fixture();
  let temporary = '';
  const bytes = '{ "lockfileVersion": 3, "packages": {}, "fromRealManager": true }\n';
  await isolatedUpgrade(root, upgrade, async (dir) => {
    temporary = dir;
    expect(dir).not.toBe(root);
    expect(git(dir, 'rev-parse', '--show-toplevel')).toBe(dir);
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toContain('^2.0.0');
    expect(readFileSync(join(root, 'node_modules/baseline'), 'utf8')).toBe('old');
    writeFileSync(join(dir, 'package-lock.json'), bytes);
    mkdirSync(join(dir, 'node_modules'));
    writeFileSync(join(dir, 'node_modules/target'), 'new');
    return {
      file: 'package-lock.json',
      manager: 'npm',
      added: ['target'],
      removed: [],
      changed: [],
      allowed: ['target'],
    };
  });
  expect(readFileSync(join(root, 'package-lock.json'), 'utf8')).toBe(bytes);
  expect(readFileSync(join(root, 'node_modules/target'), 'utf8')).toBe('new');
  expect(existsSync(temporary)).toBe(false);
  expect(git(root, 'worktree', 'list')).not.toContain('uptide-install-');
});
it('failed/out-of-scope installs never replace the branch lockfile or dependencies', async () => {
  const root = fixture(),
    before = readFileSync(join(root, 'package-lock.json'), 'utf8');
  await expect(
    isolatedUpgrade(root, upgrade, async (dir) => {
      writeFileSync(join(dir, 'package-lock.json'), 'unrelated change');
      throw new Error('outside target');
    }),
  ).rejects.toThrow('outside target');
  expect(readFileSync(join(root, 'package-lock.json'), 'utf8')).toBe(before);
  expect(readFileSync(join(root, 'node_modules/baseline'), 'utf8')).toBe('old');
});
it('disables lifecycle scripts for npm and both Yarn generations', async () => {
  const root = fixture();
  expect(packageManager(root).args).toContain('--ignore-scripts');
  const result = await command(root, process.execPath, [
    '-e',
    'console.log(process.env.npm_config_ignore_scripts, process.env.YARN_ENABLE_SCRIPTS)',
  ]);
  expect(result.output.trim()).toBe('true false');
});

it('removes stale child modules when the new installation hoists them to the root', async () => {
  const root = fixture();
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  pkg.workspaces = ['packages/*'];
  writeFileSync(join(root, 'package.json'), JSON.stringify(pkg));
  mkdirSync(join(root, 'packages/api/node_modules/target'), { recursive: true });
  writeFileSync(join(root, 'packages/api/package.json'), '{"name":"api"}');
  writeFileSync(join(root, 'packages/api/node_modules/target/stale'), 'old');
  git(root, 'add', 'package.json', 'packages/api/package.json');
  git(
    root,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.test',
    'commit',
    '-m',
    'workspace',
  );
  await isolatedUpgrade(root, upgrade, async (dir) => {
    mkdirSync(join(dir, 'node_modules/target'), { recursive: true });
    writeFileSync(join(dir, 'node_modules/target/current'), 'new');
    return {
      file: 'package-lock.json',
      manager: 'npm',
      added: [],
      removed: [],
      changed: [],
      allowed: [],
    };
  });
  expect(existsSync(join(root, 'packages/api/node_modules'))).toBe(false);
  expect(readFileSync(join(root, 'node_modules/target/current'), 'utf8')).toBe('new');
});
it('installs a project that lives below the git top level in its place inside the worktree', async () => {
  const root = fixture('frontend');
  await isolatedUpgrade(root, upgrade, async (dir) => {
    expect(dir.endsWith('/repo/frontend')).toBe(true);
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toContain('^2.0.0');
    writeFileSync(join(dir, 'package-lock.json'), '{"lockfileVersion":3,"packages":{"x":1}}\n');
    mkdirSync(join(dir, 'node_modules'));
    writeFileSync(join(dir, 'node_modules/target'), 'new');
    return {
      file: 'package-lock.json',
      manager: 'npm',
      added: ['target'],
      removed: [],
      changed: [],
      allowed: ['target'],
    };
  });
  expect(readFileSync(join(root, 'node_modules/target'), 'utf8')).toBe('new');
  expect(readFileSync(join(root, 'package-lock.json'), 'utf8')).toContain('"x":1');
});
