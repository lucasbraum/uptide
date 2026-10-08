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

  it('anchors argument mismatches at a repository parameter when several call sites trip it', async () => {
    const dir = consumerWith(
      'param.ts',
      [
        "import { boxed, type Box } from 'widget';",
        'export function use(b: Box<number>): number {',
        '  return b.a;',
        '}',
        'export const first = use(boxed());',
        'export const second = use(boxed());',
        '',
      ].join('\n'),
    );
    const signal = await compileAgainstTarget({ dir }, 'widget', join(DEPS, 'widget-v3'));
    const mismatches = signal.diagnostics.filter(
      (d) => d.file === 'src/param.ts' && d.code === 2345,
    );
    expect(mismatches.map((d) => d.line)).toEqual([5, 6]);
    for (const d of mismatches)
      expect(d.cause).toEqual({
        name: 'b',
        file: 'src/param.ts',
        line: 2,
        reason:
          "whose parameter `b: Box<number>` no longer accepts what the target gives it; widen the parameter's type there",
        anchorOnly: true,
      });
  });

  it('leaves a parameter one site trips to that site', async () => {
    const dir = consumerWith(
      'single.ts',
      [
        "import { boxed, type Box } from 'widget';",
        'export function use(b: Box<number>): number {',
        '  return b.a;',
        '}',
        'export const only = use(boxed());',
        '',
      ].join('\n'),
    );
    const signal = await compileAgainstTarget({ dir }, 'widget', join(DEPS, 'widget-v3'));
    const at5 = signal.diagnostics.find((d) => d.file === 'src/single.ts' && d.line === 5);
    expect(at5?.code).toBe(2345);
    expect(at5?.cause?.anchorOnly).toBeUndefined();
  });
});
