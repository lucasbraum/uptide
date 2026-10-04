import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PackageFetcher } from '../../domain/io.js';
import { compileAgainstTarget, compileAgainstTargets } from './compile.js';

const ROOT = resolve(import.meta.dirname, '../../../../../fixtures');
const CONSUMER = join(ROOT, 'repos/synthetic-consumer');

/** A copy of the consumer whose `paths` still point at the fixture package. */
function consumerCopy(mutate: (dir: string) => void): string {
  const dir = mkdtempSync(join(tmpdir(), 'uptide-consumer-'));
  cpSync(CONSUMER, dir, { recursive: true });
  const tsconfig = JSON.parse(readFileSync(join(dir, 'tsconfig.json'), 'utf8')) as {
    compilerOptions: { paths: Record<string, string[]> };
  };
  for (const key of Object.keys(tsconfig.compilerOptions.paths)) {
    tsconfig.compilerOptions.paths[key] = (tsconfig.compilerOptions.paths[key] as string[]).map(
      (p) => resolve(CONSUMER, p),
    );
  }
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify(tsconfig));
  mutate(dir);
  return dir;
}

describe('Signal B: compile against the target version', () => {
  it('reports the errors the upgrade introduces, at the right lines', async () => {
    const signal = await compileAgainstTarget(
      { dir: CONSUMER },
      'synthetic',
      join(ROOT, 'synthetic-v2'),
    );
    expect(signal.skipped).toBeUndefined();
    expect(signal.baselineErrors).toBe(0);
    expect(signal.unresolvedInTarget).toEqual([]);
    expect(signal.diagnostics.map((d) => `${d.file}:${d.line} ${d.code} ${d.message}`)).toEqual([
      'src/chains.ts:6 2554 Expected 2 arguments, but got 1.',
    ]);
    expect(signal.timing.overlayMs).toBeGreaterThan(0);
  });

  it('subtracts pre-existing errors instead of skipping: the upgrade error is still found', async () => {
    const dir = consumerCopy((d) =>
      writeFileSync(join(d, 'src/broken.ts'), 'export const n: number = "not a number";\n'),
    );
    const signal = await compileAgainstTarget({ dir }, 'synthetic', join(ROOT, 'synthetic-v2'));
    expect(signal.skipped).toBeUndefined();
    expect(signal.baselineErrors).toBe(1);
    expect(signal.diagnostics.map((d) => `${d.file}:${d.line} ${d.code}`)).toEqual([
      'src/chains.ts:6 2554',
    ]);
  });

  it('counts modules the target imports that neither it nor the consumer can resolve, without making findings of them', async () => {
    const v2 = mkdtempSync(join(tmpdir(), 'uptide-v2-'));
    cpSync(join(ROOT, 'synthetic-v2'), v2, { recursive: true });
    const index = join(v2, 'dist/index.d.ts');
    writeFileSync(
      index,
      `import type { Widget } from 'some-missing-dep';\n${readFileSync(index, 'utf8')}\nexport declare function widget(): Widget;\n`,
    );
    const signal = await compileAgainstTarget({ dir: CONSUMER }, 'synthetic', v2);
    expect(signal.unresolvedInTarget).toEqual(['some-missing-dep']);
    expect(signal.diagnostics.map((d) => `${d.file}:${d.line} ${d.code}`)).toEqual([
      'src/chains.ts:6 2554',
    ]);
  });

  it('skips only a structurally broken baseline, with a reason', async () => {
    const dir = consumerCopy((d) => writeFileSync(join(d, 'tsconfig.json'), '{ this is not json'));
    const signal = await compileAgainstTarget({ dir }, 'synthetic', join(ROOT, 'synthetic-v2'));
    expect(signal.skipped).toMatch(/invalid tsconfig/);
    expect(signal.diagnostics).toEqual([]);
  });
});

describe("Signal B: the target's own dependencies", () => {
  const DEPS = join(ROOT, 'deps');
  const CONSUMER = join(ROOT, 'repos/dep-consumer');
  const registry = (calls: string[]): PackageFetcher => ({
    async resolve(_name, requested) {
      return requested;
    },
    async versions(name) {
      calls.push(`versions ${name}`);
      return name === '@scope/core' ? ['1.0.0', '2.0.0', '3.0.0-beta.1'] : [];
    },
    async fetch(name, version) {
      calls.push(`fetch ${name}@${version}`);
      const dir = mkdtempSync(join(tmpdir(), 'uptide-dep-'));
      cpSync(join(DEPS, `scope-core-v${version[0]}`), dir, { recursive: true });
      return { name, version, dir };
    },
  });

  it("links @scope/core@2 for widget@2 instead of the consumer's @scope/core@1", async () => {
    const calls: string[] = [];
    const signal = await compileAgainstTarget(
      { dir: CONSUMER },
      'widget',
      join(DEPS, 'widget-v2'),
      {
        fetcher: registry(calls),
      },
    );
    expect(calls).toEqual(['versions @scope/core', 'fetch @scope/core@2.0.0']);
    expect(signal.linkedDependencies).toEqual(['@scope/core@2.0.0 (fetched)']);
    expect(signal.unsatisfiedDependencies).toEqual([]);
    expect(signal.unresolvedInTarget).toEqual([]);
    expect(signal.diagnostics).toEqual([]);
  });

  it("without a registry the consumer's copy is all there is, and the mismatch shows", async () => {
    const signal = await compileAgainstTarget({ dir: CONSUMER }, 'widget', join(DEPS, 'widget-v2'));
    expect(signal.linkedDependencies).toEqual([]);
    expect(signal.unsatisfiedDependencies).toEqual(['@scope/core@1.0.0 does not satisfy ^2']);
    expect(signal.diagnostics.map((d) => `${d.file}:${d.line} ${d.code}`)).toEqual([
      'src/index.ts:3 2339',
    ]);
  });

  it("uses the consumer's copy when it satisfies the declared range, without touching the registry", async () => {
    const v2 = mkdtempSync(join(tmpdir(), 'uptide-widget-'));
    cpSync(join(DEPS, 'widget-v2'), v2, { recursive: true });
    writeFileSync(
      join(v2, 'package.json'),
      JSON.stringify({
        name: 'widget',
        version: '2.0.0',
        types: './index.d.ts',
        dependencies: { '@scope/core': '^1' },
      }),
    );
    const calls: string[] = [];
    const signal = await compileAgainstTarget({ dir: CONSUMER }, 'widget', v2, {
      fetcher: registry(calls),
    });
    expect(calls).toEqual([]);
    expect(signal.linkedDependencies).toEqual([]);
    expect(signal.diagnostics.map((d) => `${d.file}:${d.line} ${d.code}`)).toEqual([
      'src/index.ts:3 2339',
    ]);
  });

  it('a release group is one overlay: both targets linked, nothing fetched for either', async () => {
    const calls: string[] = [];
    const signal = await compileAgainstTargets(
      { dir: CONSUMER },
      [
        { name: 'widget', dir: join(DEPS, 'widget-v2') },
        { name: '@scope/core', dir: join(DEPS, 'scope-core-v2') },
      ],
      { fetcher: registry(calls) },
    );
    expect(calls).toEqual([]);
    expect(signal.linkedDependencies).toEqual([]);
    expect(signal.unresolvedInTarget).toEqual([]);
    expect(signal.diagnostics).toEqual([]);
  });
});

describe('Signal B: a target dependency typed by @types', () => {
  it('links the @types package the target declares next to an untyped dependency', async () => {
    // matcher@2 imports `chalk`, which ships no types; its `Chalk` namespace comes from
    // @types/chalk, declared by matcher next to it, as vitest 5 does with chai.
    const root = mkdtempSync(join(tmpdir(), 'uptide-types-dep-'));
    const write = (file: string, text: string) => {
      mkdirSync(join(root, file, '..'), { recursive: true });
      writeFileSync(join(root, file), text);
    };
    const matcher = (version: string, body: string, deps: Record<string, string>) => {
      write(
        `matcher-${version}/package.json`,
        JSON.stringify({ name: 'matcher', version, types: 'index.d.ts', dependencies: deps }),
      );
      write(`matcher-${version}/index.d.ts`, body);
      return join(root, `matcher-${version}`);
    };
    const v1 = matcher(
      '1.0.0',
      'export interface Assertion { not: Assertion; ok(): void }\nexport declare function expect(v: unknown): Assertion;\n',
      {},
    );
    const v2 = matcher(
      '2.0.0',
      "import * as chalk from 'chalk';\nexport interface Assertion extends Chalk.Assertion { ok(): void }\nexport declare function expect(v: unknown): Assertion;\nexport { chalk };\n",
      { chalk: '^6.0.0', '@types/chalk': '^5.0.0' },
    );
    write(
      'registry/chalk/package.json',
      JSON.stringify({ name: 'chalk', version: '6.1.0', main: 'index.js' }),
    );
    write('registry/chalk/index.js', 'module.exports = {};\n');
    write(
      'registry/types-chalk/package.json',
      JSON.stringify({ name: '@types/chalk', version: '5.2.0', types: 'index.d.ts' }),
    );
    write(
      'registry/types-chalk/index.d.ts',
      'declare global { namespace Chalk { interface Assertion { not: this } } }\nexport declare const version: string;\n',
    );
    write(
      'repo/package.json',
      JSON.stringify({ name: 'repo', dependencies: { matcher: '1.0.0' } }),
    );
    write(
      'repo/tsconfig.json',
      JSON.stringify({
        compilerOptions: {
          module: 'ESNext',
          moduleResolution: 'Bundler',
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          types: [],
        },
        include: ['src'],
      }),
    );
    write('repo/src/index.ts', "import { expect } from 'matcher';\nexpect(1).not.ok();\n");
    cpSync(v1, join(root, 'repo/node_modules/matcher'), { recursive: true });
    const calls: string[] = [];
    const fetcher: PackageFetcher = {
      resolve: async (_name, requested) => requested,
      versions: async (name) =>
        name === 'chalk' ? ['6.1.0'] : name === '@types/chalk' ? ['5.2.0'] : [],
      fetch: async (name, version) => {
        calls.push(`${name}@${version}`);
        return {
          name,
          version,
          dir: join(root, 'registry', name === 'chalk' ? 'chalk' : 'types-chalk'),
        };
      },
    };
    const signal = await compileAgainstTarget({ dir: join(root, 'repo') }, 'matcher', v2, {
      fetcher,
    });
    expect(calls.sort()).toEqual(['@types/chalk@5.2.0', 'chalk@6.1.0']);
    // `.not` comes from the ambient namespace: with it linked, the consumer's code compiles.
    expect(signal.diagnostics).toEqual([]);
  });
});

describe('workspace dependencies compile from source', () => {
  const APP = join(ROOT, 'repos/workspace-consumer/packages/app');

  it('resolves a linked workspace package to its source, not its stale dist', async () => {
    const signal = await compileAgainstTarget(
      { dir: APP },
      'synthetic',
      join(ROOT, 'synthetic-v2'),
    );
    // With the stale dist, `fresh` would be a baseline error; from source it is not.
    expect(signal.baselineErrors).toBe(0);
    expect(signal.diagnostics.map((d) => `${d.file}:${d.line} ${d.code}`)).toEqual([
      'src/index.ts:4 2554',
    ]);
  });
});

describe('JavaScript is checked on both sides', () => {
  it('finds the upgrade error in a .js file of a repo without checkJs, and subtracts pre-existing JS errors', async () => {
    const dir = join(ROOT, 'repos/require-consumer');
    const signal = await compileAgainstTarget({ dir }, 'synthetic', join(ROOT, 'synthetic-v2'), {
      files: ['src/legacy.js', 'src/typed.ts'],
    });
    expect(signal.skipped).toBeUndefined();
    expect(signal.diagnostics.map((d) => `${d.file}:${d.line} ${d.code}`)).toEqual([
      'src/legacy.js:4 2554',
      'src/typed.ts:3 2554',
    ]);
  });
});

describe('Node16/NodeNext conditions', () => {
  const ESM = 'export declare class Client { ping(): void; }\nexport default Client;\n';
  // `export =` has no `default`: only an importer read as CommonJS would see this file.
  const CJS =
    'declare class Client { ping(): void; }\ndeclare namespace Client {}\nexport = Client;\n';
  /** One declaration file for every importer (stripe 14), or one per condition (stripe 23). */
  const release = (root: string, version: string, dual: boolean): string => {
    const dir = join(root, 'dual', version);
    mkdirSync(join(dir, 'esm'), { recursive: true });
    mkdirSync(join(dir, 'cjs'), { recursive: true });
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'dual',
        version,
        ...(dual
          ? {
              exports: {
                '.': {
                  import: { types: './esm/index.d.ts', default: './esm/index.js' },
                  require: { types: './cjs/index.d.ts', default: './cjs/index.js' },
                },
              },
            }
          : { types: './esm/index.d.ts' }),
      }),
    );
    writeFileSync(join(dir, 'esm/index.d.ts'), ESM);
    writeFileSync(join(dir, 'cjs/index.d.ts'), CJS);
    return dir;
  };

  it("resolves the target with the importing file's own format, not the probe's", async () => {
    const root = mkdtempSync(join(tmpdir(), 'uptide-nodenext-'));
    const installed = release(root, '1.0.0', false);
    const target = release(root, '2.0.0', true);
    const dir = join(root, 'repo');
    mkdirSync(join(dir, 'src'), { recursive: true });
    mkdirSync(join(dir, 'node_modules'), { recursive: true });
    cpSync(installed, join(dir, 'node_modules/dual'), { recursive: true });
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'repo', type: 'module', dependencies: { dual: '1.0.0' } }),
    );
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          types: [],
        },
        include: ['src'],
      }),
    );
    // An ES module: `import("dual").default` exists on the `import` condition only.
    writeFileSync(
      join(dir, 'src/index.ts'),
      'export const client = {} as unknown as import("dual").default;\n',
    );
    const signal = await compileAgainstTarget({ dir }, 'dual', target);
    expect(signal.skipped).toBeUndefined();
    expect(signal.diagnostics).toEqual([]);
  });
});
