import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { workspacePackagesOf } from './workspaces.js';

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

it('a pnpm-workspace.yaml with settings and no packages is a single-package repository', () => {
  expect(workspacePackagesOf(at('pnpm-settings-only'))).toEqual(['.']);
});

it('says so when the declared packages match nothing, instead of checking only the root', () => {
  expect(() => workspacePackagesOf(at('pnpm-no-match'))).toThrow(
    'pnpm-workspace.yaml declares packages (libs/*) but none of them matches a directory with a package.json; fix the patterns, or Uptide would check only the root',
  );
});

it('names a workspace file that is not YAML, and skips node_modules and dot-directories', () => {
  const root = mkdtempSync(join(tmpdir(), 'uptide-workspaces-'));
  writeFileSync(join(root, 'package.json'), '{}');
  for (const dir of ['packages/a', 'packages/a/node_modules/dep', '.cache/b', 'packages/.hidden'])
    mkdirSync(join(root, dir), { recursive: true });
  for (const dir of ['packages/a', 'packages/a/node_modules/dep', '.cache/b', 'packages/.hidden'])
    writeFileSync(join(root, dir, 'package.json'), '{}');
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages: ["**"]\n');
  expect(workspacePackagesOf(root)).toEqual(['.', 'packages/a']);
  writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages: ['packages/*'\n");
  expect(() => workspacePackagesOf(root)).toThrow(/^pnpm-workspace.yaml is not valid YAML: /);
});
