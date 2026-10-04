import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { type ScanStats, scanImports } from './scan.js';
import { parseSource, sourceCandidate } from './source.js';

const roots: string[] = [];
function fixture(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'uptide-scan-'));
  roots.push(cwd);
  return cwd;
}
function write(root: string, file: string, text = "import sample from 'sample'; sample();"): void {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), text);
}
const stats = (): ScanStats => ({
  sourceMs: 0,
  configMs: 0,
  sourceFiles: 0,
  configFiles: 0,
  assetFiles: 0,
  visitedFiles: 0,
});
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it('prunes vendor/generated directories and files, respects scoped ignore rules and negation, and reports honest skip counts', async () => {
  const cwd = fixture();
  for (const dir of ['bower_components', 'vendor', 'dist', 'build', 'coverage', 'node_modules'])
    write(cwd, `${dir}/hidden.js`);
  for (const file of ['app.min.js', 'app.bundle.js', 'app.js.map']) write(cwd, file);
  write(cwd, '.gitignore', 'generated/\n*.ignored.js\n!keep.ignored.js\n');
  write(cwd, 'generated/hidden.js');
  write(cwd, 'lost.ignored.js');
  write(cwd, 'keep.ignored.js');
  write(cwd, 'nested/.gitignore', 'local.js\n!allowed.ignored.js\n');
  write(cwd, 'nested/local.js');
  write(cwd, 'nested/allowed.ignored.js');
  write(cwd, 'elsewhere/local.js');
  write(cwd, '.eslintignore', 'eslint-only.js\n');
  write(cwd, 'eslint-only.js');
  write(cwd, '.prettierignore', 'prettier-only.scss\n');
  write(cwd, 'prettier-only.scss', '@use "sample";');
  write(
    cwd,
    'package.json',
    JSON.stringify({
      standard: { ignore: ['old/**', 'mixed/**', '!mixed/keep.js'] },
      'lint-staged': { linters: { '*.js': 'standard' }, ignore: ['lint-output/'] },
    }),
  );
  write(cwd, 'old/hidden.js');
  write(cwd, 'mixed/hidden.js');
  write(cwd, 'mixed/keep.js');
  write(cwd, 'lint-output/hidden.js');
  write(cwd, 'app.js');
  write(cwd, 'plain.js', 'const unrelated = 123;');
  write(cwd, 'comment.js', "// require('sample')\nconst label = 'sample';");
  symlinkSync(join(cwd, 'app.js'), join(cwd, 'linked.js'));
  const counts = stats();
  const usage = await scanImports(cwd, ['sample'], ['.'], [], new Map(), counts);
  expect(usage.get('sample')?.files).toEqual([
    'app.js',
    'elsewhere/local.js',
    'keep.ignored.js',
    'mixed/keep.js',
    'nested/allowed.ignored.js',
  ]);
  expect(usage.get('sample')?.callSites).toBe(5);
  expect(counts.parsedFiles).toBe(5);
  expect(counts.skipped).toMatchObject({
    '.gitignore': { files: 2, directories: 1 },
    '.eslintignore': { files: 1, directories: 0 },
    '.prettierignore': { files: 1, directories: 0 },
    'standard.ignore': { files: 2, directories: 0 },
    'lint-staged.ignore': { files: 0, directories: 1 },
    'generated files (*.min.js, *.bundle.js, *.map)': { files: 3, directories: 0 },
    'no dependency text': { files: 1 },
    'no dependency imports (lexer)': { files: 1 },
    'symbolic links': { files: 1 },
  });
});
it.each([
  "import { run as execute } from 'sample'; execute();",
  "const {run} = require('sample/sub'); run();",
  "export {thing} from 'sample';",
  "import Sample = require('sample'); Sample();",
  "const mod = await import('sample'); mod.run();",
  'const mod = require(`sample`); mod.run();',
  "import value from 's\\u0061mple'; value();",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal source under test
  "const text = `before ${require('sample')} after`;",
  "const pattern = /['\"]/; const tool = require('sample'); tool();",
  "import Widget from 'sample'; export const element = <Widget />;",
  "import tool from 'sample'; function nested(tool) { tool(); } tool();",
])('lexer never drops supported module syntax: %s', async (text) => {
  expect(sourceCandidate(text, ['sample'])).toBeUndefined();
  const cwd = fixture();
  write(cwd, 'app.tsx', text);
  const usage = await scanImports(cwd, ['sample'], ['.']);
  expect([...usage]).toEqual([
    ...parseSource({ file: 'app.tsx', text, workspace: '.' }, ['sample']),
  ]);
  expect(usage.has('sample')).toBe(true);
});
it('parallel and sequential parsing preserve bindings, shadowing, counts and deterministic file order', async () => {
  const cwd = fixture();
  for (let i = 0; i < 12; i++)
    write(
      cwd,
      `file-${i}.js`,
      "import tool from 'sample'; function nested(tool) { tool(); } tool(); register(tool);",
    );
  const serial = await scanImports(cwd, ['sample'], ['.'], [], new Map(), stats(), [], 0);
  const counts = stats();
  const parallel = await scanImports(cwd, ['sample'], ['.'], [], new Map(), counts, [], 2);
  expect(parallel).toEqual(serial);
  expect(counts.workers).toBe(2);
  expect(parallel.get('sample')).toMatchObject({ callSites: 12, references: 12 });
});
