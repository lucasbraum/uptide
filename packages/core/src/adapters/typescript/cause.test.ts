import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileAgainstTarget } from './compile.js';

const ROOT = resolve(import.meta.dirname, '../../../../../fixtures');
const DEPS = join(ROOT, 'deps');

/** A copy of the dep consumer with one extra source file; `widget` resolves through the fixture paths. */
function consumerWith(name: string, source: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'uptide-cause-'));
  cpSync(join(ROOT, 'repos/dep-consumer'), dir, { recursive: true });
  const tsconfig = JSON.parse(readFileSync(join(dir, 'tsconfig.json'), 'utf8'));
  for (const key of Object.keys(tsconfig.compilerOptions.paths))
    tsconfig.compilerOptions.paths[key] = tsconfig.compilerOptions.paths[key].map((p: string) =>
      resolve(join(ROOT, 'repos/dep-consumer'), p),
    );
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify(tsconfig));
  writeFileSync(join(dir, 'src', name), source);
  return dir;
}

describe('root cause guard', () => {
  it('blames a repo declaration whose own type changed between versions', async () => {
    const dir = consumerWith(
      'make.ts',
      [
        "import { boxed } from 'widget';",
        'export function make() {',
        '  return boxed();',
        '}',
        'export const k: number = make().a;',
        '',
      ].join('\n'),
    );
    const signal = await compileAgainstTarget({ dir }, 'widget', join(DEPS, 'widget-v3'));
    const at5 = signal.diagnostics.find((d) => d.file === 'src/make.ts' && d.line === 5);
    expect(at5?.cause).toEqual({
      name: 'make',
      file: 'src/make.ts',
      line: 2,
      reason: 'whose type changed from `() => Box<number>` to `() => Box<unknown>`',
    });
  });

  it('does not blame a declaration that compiles unchanged, whatever flows through it', async () => {
    const dir = consumerWith(
      'take.ts',
      [
        "import { boxed, type Box } from 'widget';",
        'export function take<T>(v: Box<T>): T {',
        '  return v.a;',
        '}',
        'export const n: number = take(boxed());',
        '',
      ].join('\n'),
    );
    const signal = await compileAgainstTarget({ dir }, 'widget', join(DEPS, 'widget-v3'));
    const at5 = signal.diagnostics.find((d) => d.file === 'src/take.ts' && d.line === 5);
    expect(at5?.message).toMatch(/unknown/);
    expect(at5?.cause).toBeUndefined();
  });

  it('traces an any value to the import it came from', async () => {
    const dir = consumerWith(
      'origin.ts',
      [
        "import { thing } from 'widget';",
        'export const doubled = thing.map((x) => x * 2);',
        '',
      ].join('\n'),
    );
    const signal = await compileAgainstTarget({ dir }, 'widget', join(DEPS, 'widget-v3'));
    const implicitAny = signal.diagnostics.find((d) => d.code === 7006);
    expect(implicitAny?.cause).toEqual({
      name: 'thing',
      file: 'src/origin.ts',
      line: 1,
      reason: 'imported from `widget`, which is typed `any` against the target',
    });
  });
});
