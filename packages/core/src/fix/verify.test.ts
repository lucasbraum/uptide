import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { diagnostics, typeResolutionFailure } from './verify.js';

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * A pnpm workspace with the isolated node-linker: nothing is hoisted to the root, each
 * package sees `@types/node` only through its own `node_modules` symlink into the store.
 * The types declare a global no other `@types/node` has, so a program that picks up
 * whatever the process's working directory offers fails here too.
 */
function isolatedWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'uptide-isolated-'));
  dirs.push(root);
  const write = (path: string, text: string): void => {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  write('package.json', JSON.stringify({ name: 'root', private: true }));
  write('pnpm-workspace.yaml', "packages: ['packages/*']\n");
  write('.npmrc', 'node-linker=isolated\n');
  const store = 'node_modules/.pnpm/@types+node@24.0.0/node_modules/@types/node';
  write(`${store}/package.json`, JSON.stringify({ name: '@types/node', version: '24.0.0' }));
  write(
    `${store}/index.d.ts`,
    [
      'declare var __fixtureNodeTypes: true;',
      'declare var Buffer: { from(text: string): { toString(encoding: string): string } };',
      "declare module 'node:crypto' { export function createHash(algorithm: string): { digest(encoding: string): string } }",
    ].join('\n'),
  );
  const options = { strict: true, module: 'NodeNext', moduleResolution: 'NodeNext' };
  write('tsconfig.base.json', JSON.stringify({ compilerOptions: { ...options, types: ['node'] } }));
  // One package names its types; the other inherits them from the root's base config, where
  // the root has no @types of its own to offer.
  const configs = {
    a: { compilerOptions: { ...options, types: ['node'] }, include: ['index.ts'] },
    b: { extends: '../../tsconfig.base.json', include: ['index.ts'] },
  };
  for (const [name, config] of Object.entries(configs)) {
    write(
      `packages/${name}/package.json`,
      JSON.stringify({ name, devDependencies: { '@types/node': '^24.0.0' } }),
    );
    write(`packages/${name}/tsconfig.json`, JSON.stringify(config));
    write(
      `packages/${name}/index.ts`,
      [
        "import { createHash } from 'node:crypto';",
        'export const seen: true = __fixtureNodeTypes;',
        "export const text: string = Buffer.from('x').toString('base64');",
        "export const hash: string = createHash('sha256').digest('hex');",
      ].join('\n'),
    );
    mkdirSync(join(root, `packages/${name}/node_modules/@types`), { recursive: true });
    symlinkSync(join(root, store), join(root, `packages/${name}/node_modules/@types/node`), 'dir');
  }
  return root;
}

it('resolves each workspace types from its own node_modules under the isolated pnpm layout', () => {
  const root = isolatedWorkspace();
  const baseline = diagnostics(root, ['packages/a', 'packages/b']);
  expect(baseline).toEqual([]);
  expect(typeResolutionFailure(root, baseline)).toBeUndefined();
});

it('calls a baseline that cannot see installed, declared types a resolution failure', () => {
  const root = isolatedWorkspace();
  const at = (file: string, code: number, message: string) => ({
    file,
    line: 1,
    column: 1,
    code,
    message,
  });
  const failure = typeResolutionFailure(root, [
    at('packages/a/tsconfig.json', 2688, "Cannot find type definition file for 'node'."),
    at(
      'packages/b/index.ts',
      2591,
      "Cannot find name 'Buffer'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node` and then add 'node' to the types field in your tsconfig.",
    ),
    at(
      'packages/b/index.ts',
      2307,
      "Cannot find module 'node:crypto' or its corresponding type declarations.",
    ),
  ]);
  expect(failure).toBe('3 baseline errors cannot see @types/node, which is declared and installed');
  // A package that is genuinely missing is the repository's own error, not ours.
  expect(
    typeResolutionFailure(root, [
      at(
        'packages/a/index.ts',
        2307,
        "Cannot find module 'left-pad' or its corresponding type declarations.",
      ),
    ]),
  ).toBeUndefined();
});
