import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';
import { isolatedFix } from '../isolate.js';
import { git } from '../process.js';
import { zodFixture } from '../test-fixture.js';
import { assertNpmLockSync } from './npm-sync.js';

const scratch = mkdtempSync(join(tmpdir(), 'uptide-lock-sync-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
function fixture() {
  const f = zodFixture(scratch);
  rmSync(join(f.root, 'pnpm-lock.yaml'));
  const json = JSON.parse(readFileSync(join(f.root, 'package.json'), 'utf8'));
  const lock = {
    lockfileVersion: 3,
    packages: { '': json, 'node_modules/zod': { version: '3.25.76' } },
  };
  writeFileSync(join(f.root, 'package-lock.json'), JSON.stringify(lock));
  git(f.root, 'add', '.');
  git(f.root, 'commit', '-m', 'npm baseline');
  return { ...f, json, lock };
}
it.each([2, 3])('accepts a synchronized npm lockfile v%s without touching files', (version) => {
  const { root, lock } = fixture();
  lock.lockfileVersion = version;
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify(lock));
  const before = git(root, 'status', '--porcelain');
  expect(() => assertNpmLockSync(root)).not.toThrow();
  expect(git(root, 'status', '--porcelain')).toBe(before);
});
it.each(['changed range', 'missing entry', 'wrong version', 'extra declaration'])(
  'rejects %s before clone, check or install',
  async (problem) => {
    const { root, lock, services } = fixture();
    if (problem === 'changed range') lock.packages[''].dependencies.zod = '^2';
    if (problem === 'missing entry') Reflect.deleteProperty(lock.packages, 'node_modules/zod');
    if (problem === 'wrong version') lock.packages['node_modules/zod'].version = '2.0.0';
    if (problem === 'extra declaration')
      Object.assign(lock.packages[''].dependencies, { extra: '1' });
    writeFileSync(join(root, 'package-lock.json'), JSON.stringify(lock));
    git(root, 'commit', '-am', 'stale lock');
    const check = vi.fn(services.check),
      install = vi.fn(services.install);
    await expect(
      isolatedFix({ cwd: root, only: 'zod', fixer: null }, { ...services, check, install }),
    ).rejects.toThrow('the lockfile does not match package.json; run npm install first');
    expect(check).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
    expect(git(root, 'branch', '--show-current')).not.toContain('uptide/');
  },
);
it('checks committed content, not an uncommitted lockfile repair', async () => {
  const { root, lock, services } = fixture();
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ ...lock, packages: {} }));
  git(root, 'commit', '-am', 'stale lock');
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify(lock));
  await expect(isolatedFix({ cwd: root, only: 'zod', fixer: null }, services)).rejects.toThrow(
    'package.json has no importer',
  );
});
it('checks workspace importers and hoisted resolutions, permitting links and absent optional packages', () => {
  const { root, json, lock } = fixture();
  Object.assign(json, { workspaces: ['packages/*'], optionalDependencies: { platform: '^1' } });
  writeFileSync(join(root, 'package.json'), JSON.stringify(json));
  mkdirSync(join(root, 'packages/app'), { recursive: true });
  const app = { dependencies: { zod: '^3', local: '*' } };
  writeFileSync(join(root, 'packages/app/package.json'), JSON.stringify(app));
  Object.assign(lock.packages, {
    '': json,
    'packages/app': app,
    'node_modules/local': { link: true, resolved: 'packages/local' },
  });
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify(lock));
  expect(() => assertNpmLockSync(root)).not.toThrow();
  writeFileSync(join(root, 'packages/app/package.json'), '{"dependencies":{"zod":"^4"}}');
  expect(() => assertNpmLockSync(root)).toThrow('packages/app/package.json dependencies.zod');
});
