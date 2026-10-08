import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ts } from 'ts-morph';
import { expect, it } from 'vitest';
import { inheritedTsconfigOf, loadRepo } from './repo.js';

it('a workspace without a tsconfig takes the options of the one above it, not its files', () => {
  // excalidraw-app has no tsconfig; the root's `include` covers it, with `jsx: react-jsx`.
  const root = mkdtempSync(join(tmpdir(), 'uptide-inherited-'));
  writeFileSync(join(root, 'package.json'), '{"name":"root"}');
  writeFileSync(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { jsx: 'react-jsx', esModuleInterop: true, strict: false },
      include: ['packages', 'app'],
    }),
  );
  const app = join(root, 'app');
  mkdirSync(join(app, 'src'), { recursive: true });
  writeFileSync(join(app, 'package.json'), '{"name":"app"}');
  writeFileSync(join(app, 'src', 'index.tsx'), 'export const x = <div />;\n');
  mkdirSync(join(root, 'packages', 'lib'), { recursive: true });
  writeFileSync(join(root, 'packages', 'lib', 'index.ts'), 'export const lib = 1;\n');
  expect(inheritedTsconfigOf(app)).toBe(join(root, 'tsconfig.json'));
  expect(inheritedTsconfigOf(root)).toBeUndefined();
  const repo = loadRepo(app);
  expect(repo.tsconfig).toBeUndefined();
  expect(repo.inheritedTsconfig).toBe(join(root, 'tsconfig.json'));
  const options = repo.project.getCompilerOptions();
  expect(options.jsx).toBe(ts.JsxEmit.ReactJSX);
  expect(options.esModuleInterop).toBe(true);
  expect(options.strict).toBe(false);
  // The root's file list is not the workspace's: only its own sources are loaded.
  expect(repo.project.getSourceFiles().map((f) => f.getFilePath())).toEqual([
    join(app, 'src', 'index.tsx'),
  ]);
});
