import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { workspacePackagesOf, workspacePackagesOrRoot } from './workspaces.js';

const FIXTURES = resolve(import.meta.dirname, '../../../fixtures/workspaces');
const at = (name: string): string => join(FIXTURES, name);

it.each([['pnpm-block'], ['pnpm-flow']])(
  'reads %s pnpm-workspace.yaml: quotes, comments, ** at any depth, ! exclusions',
  (form) => {
    // packages/core/test/fixture has a package.json too; `!**/test/**` keeps it out.
    expect(workspacePackagesOf(at(form))).toEqual(['.', 'apps/web', 'packages/core']);
  },
);

it.each([['npm-array'], ['yarn-object']])('reads package.json "workspaces" as %s', (form) => {
  expect(workspacePackagesOf(at(form))).toEqual(['.', 'apps/web', 'packages/core']);
});

it('finds packages named like build output: packages/build, packages/dist, tools/out', () => {
  expect(workspacePackagesOf(at('pnpm-build-names'))).toEqual([
    '.',
    'packages/build',
    'packages/core',
    'packages/dist',
    'tools/out',
  ]);
});

it('does not walk ** into node_modules or build output, though a build-named package matches', () => {
  // packages/a/node_modules/dep, packages/a/dist/bundle and packages/build/fixtures/inner all
  // have a package.json; only what is reached without entering those directories counts.
  expect(workspacePackagesOf(at('pnpm-globstar'))).toEqual(['.', 'packages/a', 'packages/build']);
});

it('a pnpm-workspace.yaml that names only the root is a single-package repository, not an error', () => {
  expect(workspacePackagesOf(at('pnpm-root-only'))).toEqual(['.']);
});

it('a pnpm-workspace.yaml with settings and no packages is a single-package repository', () => {
  expect(workspacePackagesOf(at('pnpm-settings-only'))).toEqual(['.']);
});

it('says so when the declared packages match nothing, instead of checking only the root', () => {
  expect(() => workspacePackagesOf(at('pnpm-no-match'))).toThrow(
    'pnpm-workspace.yaml declares packages (libs/*) but none of them matches a directory with a package.json; fix the patterns, or Uptide would check only the root',
  );
});

/** A scratch repository: a root package.json, a workspace file, and package.json in each dir. */
function repo(yaml: string, dirs: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'uptide-workspaces-'));
  writeFileSync(join(root, 'package.json'), '{}');
  writeFileSync(join(root, 'pnpm-workspace.yaml'), yaml);
  for (const dir of dirs) {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, 'package.json'), '{}');
  }
  return root;
}

it('never matches node_modules, and matches but does not walk into dot-directories and build output', () => {
  const root = repo('packages: ["**", "tools/build"]\n', [
    'packages/a',
    'packages/a/node_modules/dep',
    'packages/a/dist/bundled',
    'packages/coverage/report',
    '.cache/b',
    'packages/.hidden',
    'tools/build',
  ]);
  expect(workspacePackagesOf(root)).toEqual(['.', 'packages/.hidden', 'packages/a', 'tools/build']);
});

it('is an error for a workspace file that is not YAML, and the root alone for a probe', () => {
  const root = repo("packages: ['packages/*'\n", ['packages/a']);
  expect(() => workspacePackagesOf(root)).toThrow(/^pnpm-workspace.yaml is not valid YAML: /);
  expect(workspacePackagesOrRoot(root)).toEqual(['.']);
});

it('resolves a root once per process, and hands out copies', () => {
  const root = repo("packages: ['packages/*']\n", ['packages/a']);
  const first = workspacePackagesOf(root);
  first.push('mutated');
  // Read again from disk this would now be invalid; the memo answers instead.
  writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages: ['libs/*']\n");
  expect(workspacePackagesOf(root)).toEqual(['.', 'packages/a']);
});
