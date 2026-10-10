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
    // The declaration it traces to is kept: a site in another workspace at the same
    // parameter folds with it after the merge (check/root-cause.ts).
    expect(at5?.root).toEqual({
      name: 'b',
      file: 'src/single.ts',
      line: 2,
      reason:
        "whose parameter `b: Box<number>` no longer accepts what the target gives it; widen the parameter's type there",
      anchorOnly: true,
    });
  });
});

describe('a member declared in a repository augmentation the target no longer reads', () => {
  /** The dep consumer with `matchers` 1 installed (the global-reading assertion) and the given sources. */
  function withMatchers(files: Record<string, string>): string {
    const dir = consumerWith('setup.ts', files['setup.ts'] ?? '');
    const tsconfig = JSON.parse(readFileSync(join(dir, 'tsconfig.json'), 'utf8'));
    tsconfig.compilerOptions.paths.matchers = [join(DEPS, 'matchers-v1/index.d.ts')];
    tsconfig.compilerOptions.paths['matchers-extra'] = [join(DEPS, 'matchers-extra-v1/index.d.ts')];
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify(tsconfig));
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    manifest.dependencies.matchers = '1.0.0';
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest));
    const lock = JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8'));
    lock.packages['node_modules/matchers'] = {
      version: '1.0.0',
      resolved: `file:${join(DEPS, 'matchers-v1')}`,
    };
    writeFileSync(join(dir, 'package-lock.json'), JSON.stringify(lock));
    for (const [name, source] of Object.entries(files))
      writeFileSync(join(dir, 'src', name), source);
    return dir;
  }

  it('anchors every call site at the `declare global` block of a setup file, as one site', async () => {
    const dir = withMatchers({
      'setup.ts': [
        "import 'matchers';",
        'declare global {',
        '  namespace checks {',
        '    interface Matchers<R> {',
        '      toBeEven(): R;',
        '    }',
        '  }',
        '}',
        'export {};',
        '',
      ].join('\n'),
      'even.test.ts': [
        "import { expect } from 'matchers';",
        'expect(2).toBeEven();',
        'expect(4).toBeEven();',
        '',
      ].join('\n'),
      'odd.test.ts': ["import { expect } from 'matchers';", 'expect(6).toBeEven();', ''].join('\n'),
    });
    const signal = await compileAgainstTarget({ dir }, 'matchers', join(DEPS, 'matchers-v2'));
    const missing = signal.diagnostics.filter((d) => d.code === 2339);
    expect(missing.map((d) => `${d.file}:${d.line}`)).toEqual([
      'src/even.test.ts:2',
      'src/even.test.ts:3',
      'src/odd.test.ts:2',
    ]);
    const cause = {
      name: 'checks.Matchers',
      file: 'src/setup.ts',
      line: 2,
      reason:
        'which declares `toBeEven` on `checks.Matchers`, a global augmentation the target no longer reads; declare the matchers on the interface the target reads instead',
      anchorOnly: true,
    };
    // Every site, the lone one in odd.test.ts included: the edit is never at the call.
    for (const d of missing) {
      expect(d.cause).toEqual(cause);
      expect(d.root).toEqual(cause);
    }
  });

  it('leaves a member the package itself dropped to the site', async () => {
    const dir = withMatchers({
      'plain.test.ts': ["import { expect } from 'matchers';", 'expect(1).toBe(1);', ''].join('\n'),
    });
    const signal = await compileAgainstTarget({ dir }, 'matchers', join(DEPS, 'matchers-v2'));
    expect(signal.diagnostics.filter((d) => d.file === 'src/plain.test.ts')).toEqual([]);
  });

  it('anchors a member another package declared on the interface the setup file augments', async () => {
    // `toBeOdd` comes from matchers-extra's own types, on the same global `checks.Matchers`
    // the setup file augments: that augmentation is where every matcher moves together.
    const dir = withMatchers({
      'setup.ts': [
        "import 'matchers';",
        "import 'matchers-extra';",
        'declare global {',
        '  namespace checks {',
        '    interface Matchers<R> {',
        '      toBeEven(): R;',
        '    }',
        '  }',
        '}',
        'export {};',
        '',
      ].join('\n'),
      'odd.test.ts': ["import { expect } from 'matchers';", 'expect(3).toBeOdd();', ''].join('\n'),
    });
    const signal = await compileAgainstTarget({ dir }, 'matchers', join(DEPS, 'matchers-v2'));
    const [missing] = signal.diagnostics.filter((d) => d.code === 2339);
    expect(missing?.file).toBe('src/odd.test.ts');
    expect(missing?.cause).toEqual({
      name: 'checks.Matchers',
      file: 'src/setup.ts',
      line: 3,
      reason:
        'which augments `checks.Matchers`, the interface `toBeOdd` is declared on (by matchers-extra), a global augmentation the target no longer reads; declare the matchers on the interface the target reads instead',
      anchorOnly: true,
    });
  });
});
