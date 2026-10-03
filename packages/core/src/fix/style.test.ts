import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { detectStyle, formatFiles, lintFiles } from './style.js';

const scratch = mkdtempSync(join(tmpdir(), 'uptide-style-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
function repo(files: Record<string, string>, bins: Record<string, string> = {}) {
  const root = mkdtempSync(join(scratch, 'repo-'));
  const write = (file: string, text: string, mode?: number) => {
    mkdirSync(join(root, file, '..'), { recursive: true });
    writeFileSync(join(root, file), text, mode ? { mode } : {});
  };
  for (const [file, text] of Object.entries(files)) write(file, text);
  for (const [bin, script] of Object.entries(bins))
    write(`node_modules/.bin/${bin}`, `#!/bin/sh\n${script}\n`, 0o755);
  return root;
}

it('uses a tool only when the repository configures it and has it installed', () => {
  expect(detectStyle(repo({ 'package.json': '{}' }))).toEqual([]);
  // Configured but not installed, and installed but not configured: neither is used.
  expect(detectStyle(repo({ 'biome.json': '{}' }))).toEqual([]);
  expect(detectStyle(repo({ 'package.json': '{}' }, { biome: 'true', eslint: 'true' }))).toEqual(
    [],
  );
  const all = detectStyle(
    repo(
      {
        'biome.json': '{}',
        'package.json': JSON.stringify({ prettier: {} }),
        'eslint.config.js': 'export default [];',
      },
      { biome: 'true', prettier: 'true', eslint: 'true' },
    ),
  );
  expect(all.map((t) => t.name)).toEqual(['biome', 'prettier', 'eslint']);
  expect(all[0]?.format?.(['src/a.ts'])).toBe('biome format --write src/a.ts');
  expect(all[0]?.lint(['src/a.ts', 'src/b c.ts'])).toBe("biome check src/a.ts 'src/b c.ts'");
  expect(all[1]?.lint(['src/a.ts'])).toBe('prettier --check src/a.ts');
  // eslint only checks: nothing rewrites code with rules the migration did not choose.
  expect(all[2]?.format).toBeUndefined();
});

it('formats and lints exactly the files it is given', async () => {
  const root = repo(
    { 'biome.json': '{}', 'src/a.ts': 'a', 'src/b.ts': 'b' },
    // The stand-in records its arguments and "formats" by appending a marker to each file.
    {
      biome:
        'echo "$@" >> calls.txt; if [ "$1" = format ]; then shift 2; for f in "$@"; do echo formatted >> "$f"; done; fi',
    },
  );
  expect(await formatFiles(root, ['src/a.ts', 'src/gone.ts'])).toEqual(['biome']);
  expect(readFileSync(join(root, 'src/a.ts'), 'utf8')).toBe('aformatted\n');
  expect(readFileSync(join(root, 'src/b.ts'), 'utf8')).toBe('b');
  expect(await lintFiles(root, ['src/a.ts'])).toEqual([
    { tool: 'biome', status: 'passed', command: 'biome check src/a.ts', files: 1, output: '' },
  ]);
  expect(readFileSync(join(root, 'calls.txt'), 'utf8')).toBe(
    'format --write src/a.ts\ncheck src/a.ts\n',
  );
  expect(await formatFiles(root, [])).toEqual([]);
});

it('tells a failure the migration introduced from one that was already there', async () => {
  const root = repo(
    { 'biome.json': '{}', 'src/a.ts': 'a' },
    { biome: `echo "${'$'}PWD/src/a.ts:1 lint/style/useConst"; exit 1` },
  );
  const [failed] = await lintFiles(root, ['src/a.ts']);
  expect(failed).toMatchObject({ tool: 'biome', status: 'failed', files: 1 });
  // What it printed is kept, without this machine's path.
  expect(failed?.output).toContain('<repo>/src/a.ts:1 lint/style/useConst');
  const [known] = await lintFiles(root, ['src/a.ts'], failed ? [failed] : []);
  expect(known?.status).toBe('pre-existing');
});
