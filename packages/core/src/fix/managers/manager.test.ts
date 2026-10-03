import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { versionRange } from '../versions.js';
import { assertLockScope } from './lock-guard.js';
import { berrySkipBuild, packageManager, updateArgs } from './manager.js';
import { pnpmGraph, yarnGraph } from './text-lock.js';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});
function fixture(files: Record<string, string | undefined>) {
  const root = mkdtempSync(join(tmpdir(), 'manager-test-'));
  roots.push(root);
  writeFileSync(join(root, 'package.json'), '{}');
  for (const [f, t] of Object.entries(files)) if (t !== undefined) writeFileSync(join(root, f), t);
  return root;
}
it.each(['^', '~', ''])('preserves the %s range style', (style) => {
  expect(versionRange(`${style}3.23.8`, '4.6.5')).toBe(`${style}4.6.5`);
});
it('selects the npm lockfile version and every declaring workspace without moving dependency sections', () => {
  const root = fixture({ 'package-lock.json': '{"lockfileVersion":2,"packages":{}}' });
  const pm = packageManager(root);
  expect(updateArgs(pm, root, ['.', 'packages/a', 'packages/b'])).toEqual([
    'install',
    '--package-lock-only',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--lockfile-version=2',
    '-w',
    'packages/a',
    '-w',
    'packages/b',
    '--include-workspace-root',
  ]);
});
it.each([
  { 'yarn.lock': '# yarn lockfile v1\n' },
  { 'yarn.lock': '__metadata:\n  version: 8\n' },
  { 'yarn.lock': '', '.yarnrc.yml': 'nodeLinker: node-modules\n' },
])('detects Yarn classic or Berry from its config and header', (files) => {
  expect(packageManager(fixture(files)).kind).toBe(
    files['yarn.lock'].includes('v1') ? 'yarn-classic' : 'yarn-berry',
  );
});
it.each([false, true])('guards Yarn entries and transitive dependencies (Berry %s)', (berry) => {
  const text = (v: string, other = '1') =>
    berry
      ? `__metadata:\n  version: 8\n\n"app@workspace:.":\n  version: 0.0.0-use.local\n  dependencies:\n    target: "npm:^${v}"\n\n"target@npm:^${v}":\n  version: ${v}\n  dependencies:\n    child: "npm:^${v}"\n\n"child@npm:^${v}":\n  version: ${v}\n\n"stable@npm:1":\n  version: ${other}\n`
      : `# yarn lockfile v1\n"target@^${v}":\n  version "${v}"\n  dependencies:\n    child "^${v}"\n\n"child@^${v}":\n  version "${v}"\n\n"stable@1":\n  version "${other}"\n`;
  expect(
    assertLockScope(yarnGraph(text('1'), 'target'), yarnGraph(text('2'), 'target'), 'target').added,
  ).toHaveLength(2);
  expect(() =>
    assertLockScope(yarnGraph(text('1'), 'target'), yarnGraph(text('2', '2'), 'target'), 'target'),
  ).toThrow('stable');
});
it('keeps the pnpm guard strict about unrelated importer specs', () => {
  const text = (v: string, other = '1') =>
    `lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      target:\n        specifier: ^${v}\n        version: ${v}\n      stable:\n        specifier: ${other}\n        version: 1\npackages:\n  target@${v}:\n    resolution: {integrity: target}\n  stable@1:\n    resolution: {integrity: stable}\nsnapshots:\n  target@${v}: {}\n  stable@1: {}\n`;
  expect(
    assertLockScope(pnpmGraph(text('1'), 'target'), pnpmGraph(text('2'), 'target'), 'target').added,
  ).toHaveLength(2);
  expect(() =>
    assertLockScope(pnpmGraph(text('1'), 'target'), pnpmGraph(text('2', '2'), 'target'), 'target'),
  ).toThrow();
});

it.each([
  [2, '--skip-builds'],
  [3, '--mode=skip-builds'],
  [4, '--mode=skip-build'],
] as const)('uses the build-suppression option of Yarn %s', (version, option) => {
  expect(berrySkipBuild(version)).toBe(option);
});

it('chooses the manager package.json names when several lockfiles are present, and says which is left alone', () => {
  const both = fixture({
    'yarn.lock': '# yarn lockfile v1\n',
    'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
  });
  writeFileSync(join(both, 'package.json'), '{"packageManager":"yarn@1.22.22"}');
  const yarn = packageManager(both);
  expect(yarn.kind).toBe('yarn-classic');
  expect(yarn.lockfile).toBe('yarn.lock');
  expect(yarn.chosen).toBe('yarn.lock (packageManager says yarn); pnpm-lock.yaml left untouched');
  // Without the field, precedence decides and is named.
  writeFileSync(join(both, 'package.json'), '{}');
  const pnpm = packageManager(both);
  expect(pnpm.kind).toBe('pnpm');
  expect(pnpm.chosen).toBe(
    'pnpm-lock.yaml (first by precedence: pnpm, npm, yarn); yarn.lock left untouched',
  );
  // One lockfile: nothing to explain.
  expect(packageManager(fixture({ 'yarn.lock': '# yarn lockfile v1\n' })).chosen).toBeUndefined();
});
