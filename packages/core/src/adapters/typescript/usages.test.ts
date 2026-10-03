import { cpSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { diffSurfaces } from '../../diff/diff.js';
import { type FindUsagesResult, type Usage, usagePaths } from '../../domain/usage.js';
import { createTypescriptAdapter } from './index.js';

const CONSUMER = resolve(import.meta.dirname, '../../../../../fixtures/repos/synthetic-consumer');
const SYNTHETIC = resolve(import.meta.dirname, '../../../../../fixtures/synthetic');
const SYNTHETIC_V2 = resolve(import.meta.dirname, '../../../../../fixtures/synthetic-v2');
const adapter = createTypescriptAdapter({ now: () => new Date('2026-09-27T00:00:00.000Z') });

let cached: Promise<FindUsagesResult> | undefined;
function scan(): Promise<FindUsagesResult> {
  cached ??= adapter
    .extractSurface({ name: 'synthetic', version: '1.0.0', dir: SYNTHETIC })
    .then((surface) => adapter.findUsages({ dir: CONSUMER }, 'synthetic', surface));
  return cached;
}
const usages = async (): Promise<Usage[]> => (await scan()).usages;

const has = (list: Usage[], expected: Partial<Usage>): boolean =>
  list.some((u) =>
    Object.entries(expected).every(([k, v]) => (u as unknown as Record<string, unknown>)[k] === v),
  );

/** Position-independent view for comparing two layouts of the same consumer. */
const shape = (u: Usage): string =>
  `${u.file}:${u.line}:${u.column} ${u.symbolPath} ${u.access} ${u.via}`;

describe('findUsages on fixtures/repos/synthetic-consumer', () => {
  it('matches the reviewed snapshot', async () => {
    await expect(JSON.stringify(await usages(), null, 2)).toMatchFileSnapshot(
      resolve(CONSUMER, 'expected-usages.json'),
    );
  });

  it('covers every via', async () => {
    const list = await usages();
    for (const via of ['direct', 'alias', 'reexport', 'destructure'] as const) {
      expect(
        list.some((u) => u.via === via),
        via,
      ).toBe(true);
    }
  });

  it('covers every access kind except inferred (Signal B)', async () => {
    const list = await usages();
    for (const access of [
      'call',
      'construct',
      'read',
      'write',
      'implement',
      'typeRef',
      'import',
    ] as const) {
      expect(
        list.some((u) => u.access === access),
        access,
      ).toBe(true);
    }
  });

  it('resolves the documented shapes to canonical paths', async () => {
    const list = await usages();
    expect(
      has(list, { file: 'src/direct.ts', symbolPath: 'parse', access: 'import', via: 'alias' }),
    ).toBe(true);
    expect(
      has(list, { file: 'src/direct.ts', symbolPath: 'parse', access: 'call', via: 'alias' }),
    ).toBe(true);
    expect(has(list, { symbolPath: 'Parser.new()', access: 'construct' })).toBe(true);
    expect(has(list, { symbolPath: 'Parser#parse', access: 'call' })).toBe(true);
    expect(has(list, { symbolPath: 'Parser.create', access: 'call' })).toBe(true);
    expect(has(list, { symbolPath: 'Level.High', access: 'read' })).toBe(true);
    expect(has(list, { symbolPath: 'Parser#size', access: 'read' })).toBe(true);
    expect(has(list, { symbolPath: 'ParseOptions#strict', access: 'write' })).toBe(true);
    expect(has(list, { symbolPath: 'Item', access: 'import' })).toBe(true);
    expect(has(list, { symbolPath: 'ParseOptions', access: 'typeRef' })).toBe(true);
    expect(has(list, { symbolPath: 'chunk', access: 'call' })).toBe(true);
    expect(has(list, { symbolPath: '"./legacy":Client.new()', access: 'construct' })).toBe(true);
    expect(has(list, { file: 'src/chains.ts', symbolPath: 'Client#get', access: 'call' })).toBe(
      true,
    );
    expect(has(list, { file: 'src/chains.ts', symbolPath: 'Item#id', access: 'read' })).toBe(true);
    expect(has(list, { symbolPath: 'Parser#parse', via: 'destructure' })).toBe(true);
    expect(has(list, { symbolPath: 'Parser#parse', access: 'call', via: 'destructure' })).toBe(
      true,
    );
    expect(
      has(list, { file: 'src/chains.ts', symbolPath: 'parse', access: 'call', via: 'reexport' }),
    ).toBe(true);
    expect(has(list, { symbolPath: 'ParseOptions#hooks#onStart', access: 'implement' })).toBe(true);
    expect(has(list, { symbolPath: 'ParseOptions#hooks#onEnd', access: 'implement' })).toBe(true);
    expect(has(list, { symbolPath: 'ParseOptions#mode', access: 'write' })).toBe(true);
    expect(has(list, { symbolPath: 'Visitor', access: 'implement' })).toBe(true);
    // Inside a callback the consumer implements: a received option is read, a returned object is written.
    expect(
      has(list, {
        file: 'src/callbacks.ts',
        line: 13,
        symbolPath: 'ParseOptions#mode',
        access: 'read',
      }),
    ).toBe(true);
    expect(
      has(list, {
        file: 'src/callbacks.ts',
        line: 16,
        symbolPath: 'ParseOptions#mode',
        access: 'write',
      }),
    ).toBe(true);
    expect(has(list, { symbolPath: 'ParseOptions#hooks#onConfigure', access: 'implement' })).toBe(
      true,
    );
    expect(has(list, { symbolPath: 'ParseOptions#hooks#configure', access: 'implement' })).toBe(
      true,
    );
  });

  it('an alias usage answers to both names: a signature change on the target reaches the alias call site', async () => {
    const call = (await usages()).find((u) => u.symbolPath === 'makeClient' && u.access === 'call');
    expect(call?.canonicalPath).toBe('createClient');
    expect(usagePaths(call as Usage)).toEqual(['makeClient', 'createClient']);
    const [a, b] = await Promise.all([
      adapter.extractSurface({ name: 'synthetic', version: '1.0.0', dir: SYNTHETIC }),
      adapter.extractSurface({ name: 'synthetic', version: '2.0.0', dir: SYNTHETIC_V2 }),
    ]);
    const change = diffSurfaces(a, b).find((c) => c.path === 'createClient');
    expect(change).toMatchObject({ kind: 'signature', severity: 'breaking' });
    expect(usagePaths(call as Usage)).toContain(change?.path);
  });

  it('never reports the package itself or node_modules, and counts the files it scanned', async () => {
    const result = await scan();
    expect(result.usages.every((u) => u.file.startsWith('src/'))).toBe(true);
    expect(result.filesScanned).toBe(4);
    expect(result.includesJs).toBe(false);
    expect(result.unanalyzed).toEqual([]);
  });
});

/** A throwaway repo: `src` copied from the fixture, plus whatever the case needs. */
function tempRepo(extra: (dir: string) => void, tsconfig: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'uptide-repo-'));
  cpSync(join(CONSUMER, 'src'), join(dir, 'src'), { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'tmp', dependencies: { synthetic: '1.0.0' } }),
  );
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify(tsconfig));
  extra(dir);
  return dir;
}

/** Resolves `synthetic` through `paths`, like the committed fixture; the pnpm layout test uses node_modules instead. */
const PATHS = {
  synthetic: [join(SYNTHETIC, 'dist/index.d.ts')],
  'synthetic/utils': [join(SYNTHETIC, 'dist/sub/utils.d.ts')],
  'synthetic/legacy': [join(SYNTHETIC, 'dist/sub/legacy.d.ts')],
};

const BASE_TSCONFIG = {
  compilerOptions: {
    target: 'ES2022',
    module: 'ESNext',
    moduleResolution: 'Bundler',
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: [],
  },
  include: ['src'],
};

describe('findUsages layouts and gaps', () => {
  it('pnpm symlink layout produces the same usages as the paths layout', async () => {
    const dir = tempRepo((d) => {
      const store = join(d, 'node_modules/.pnpm/synthetic@1.0.0/node_modules');
      mkdirSync(store, { recursive: true });
      symlinkSync(SYNTHETIC, join(store, 'synthetic'), 'dir');
      symlinkSync(join(store, 'synthetic'), join(d, 'node_modules/synthetic'), 'dir');
      writeFileSync(
        join(d, 'pnpm-lock.yaml'),
        "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      synthetic:\n        specifier: 1.0.0\n        version: 1.0.0\n",
      );
    }, BASE_TSCONFIG);
    const surface = await adapter.extractSurface({
      name: 'synthetic',
      version: '1.0.0',
      dir: SYNTHETIC,
    });
    const result = await adapter.findUsages({ dir }, 'synthetic', surface);
    const expected = (await usages()).map(shape);
    expect(result.usages.map(shape)).toEqual(expected);
    expect(result.usages).toHaveLength(64);
  });

  it('follows bound require/import = require loads and reports only the flows it cannot track', async () => {
    const dir = tempRepo(
      (d) => {
        writeFileSync(
          join(d, 'src/gaps.ts'),
          "import cjs = require('synthetic');\nconst dyn = () => import('synthetic/utils');\nconst r = require('synthetic');\nconst other = require('not-synthetic');\nexport { cjs, dyn, r, other };\n",
        );
      },
      { ...BASE_TSCONFIG, compilerOptions: { ...BASE_TSCONFIG.compilerOptions, paths: PATHS } },
    );
    const surface = await adapter.extractSurface({
      name: 'synthetic',
      version: '1.0.0',
      dir: SYNTHETIC,
    });
    const result = await adapter.findUsages({ dir }, 'synthetic', surface);
    // `import cjs = require()` and `const r = require()` are bound and followed; an import()
    // returned from an arrow flows away untracked.
    expect(result.unanalyzed).toEqual([{ file: 'src/gaps.ts', line: 2, kind: 'dynamic-import' }]);
  });

  it('scans .js files only when allowJs is set', async () => {
    const js = "import { parse } from 'synthetic';\nexport const x = parse('a');\n";
    const withJs = tempRepo((d) => writeFileSync(join(d, 'src/plain.js'), js), {
      ...BASE_TSCONFIG,
      compilerOptions: {
        ...BASE_TSCONFIG.compilerOptions,
        paths: PATHS,
        allowJs: true,
        checkJs: false,
      },
    });
    const withoutJs = tempRepo((d) => writeFileSync(join(d, 'src/plain.js'), js), {
      ...BASE_TSCONFIG,
      compilerOptions: { ...BASE_TSCONFIG.compilerOptions, paths: PATHS },
    });
    const surface = await adapter.extractSurface({
      name: 'synthetic',
      version: '1.0.0',
      dir: SYNTHETIC,
    });
    const a = await adapter.findUsages({ dir: withJs }, 'synthetic', surface);
    const b = await adapter.findUsages({ dir: withoutJs }, 'synthetic', surface);
    expect(a.includesJs).toBe(true);
    expect(
      a.usages.some(
        (u) => u.file === 'src/plain.js' && u.symbolPath === 'parse' && u.access === 'call',
      ),
    ).toBe(true);
    expect(b.includesJs).toBe(false);
    expect(b.usages.some((u) => u.file === 'src/plain.js')).toBe(false);
  });
});

describe('findUsages under Node16/NodeNext', () => {
  // One declaration file per condition, as stripe 22 ships them: `export =` for require.
  const ESM = 'export declare class Client { ping(): void; }\nexport default Client;\n';
  const CJS =
    'declare class Client { ping(): void; }\ndeclare namespace Client {}\nexport = Client;\n';
  const repoOn = (type: 'module' | 'commonjs'): string => {
    const dir = mkdtempSync(join(tmpdir(), 'uptide-nodenext-usages-'));
    const dual = join(dir, 'node_modules/dual');
    mkdirSync(join(dual, 'esm'), { recursive: true });
    mkdirSync(join(dual, 'cjs'), { recursive: true });
    mkdirSync(join(dir, 'src'));
    writeFileSync(
      join(dual, 'package.json'),
      JSON.stringify({
        name: 'dual',
        version: '1.0.0',
        exports: {
          '.': {
            import: { types: './esm/index.d.ts', default: './esm/index.js' },
            require: { types: './cjs/index.d.ts', default: './cjs/index.js' },
          },
        },
      }),
    );
    writeFileSync(join(dual, 'esm/index.d.ts'), ESM);
    writeFileSync(join(dual, 'cjs/index.d.ts'), CJS);
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'repo', type, dependencies: { dual: '1.0.0' } }),
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
    writeFileSync(
      join(dir, 'src/index.ts'),
      "import Client from 'dual';\nexport const client = new Client();\nclient.ping();\n",
    );
    return dir;
  };

  it("finds usages in an ES module: the import is resolved in the file's own format", async () => {
    const dir = repoOn('module');
    const surface = await adapter.extractSurface({
      name: 'dual',
      version: '1.0.0',
      dir: join(dir, 'node_modules/dual'),
    });
    const result = await adapter.findUsages({ dir }, 'dual', surface);
    const paths = result.usages.map((u) => u.symbolPath);
    expect(paths).toContain('Client#ping');
    expect(result.usages.every((u) => u.file === 'src/index.ts')).toBe(true);
  });
});

describe('findUsages on values the import does not visibly reach', () => {
  it('resolves a distinctive member on a value another module returned, and infers the one meaning on an any-typed receiver', async () => {
    const dir = tempRepo(
      (d) => {
        // `state()` hides the import: the consumer file never names the package, like a
        // workspace reading what a sibling package's helper returned.
        writeFileSync(
          join(d, 'src/state.ts'),
          "import type { InternalState, Item } from 'synthetic';\nexport const state = (): InternalState => ({ ticks: 0 });\nexport const item = (): Item => ({ id: 'a', quantity: 1 });\n",
        );
        writeFileSync(
          join(d, 'src/reader.ts'),
          "import { state, item } from './state.js';\nexport const t = state().ticks;\nexport const i = item().id;\n",
        );
        // An importing file reading through `any`: the checker knows nothing, the name does.
        writeFileSync(
          join(d, 'src/loose.ts'),
          "import type { InternalState } from 'synthetic';\nexport const read = (s: any): number => s.ticks;\nexport const typed = (s: InternalState): number => s.ticks;\nexport const ambiguous = (s: any): string => s.id;\n",
        );
      },
      { ...BASE_TSCONFIG, compilerOptions: { ...BASE_TSCONFIG.compilerOptions, paths: PATHS } },
    );
    const surface = await adapter.extractSurface({
      name: 'synthetic',
      version: '1.0.0',
      dir: SYNTHETIC,
    });
    const found = (await adapter.findUsages({ dir }, 'synthetic', surface)).usages;
    const at = (file: string, line: number) =>
      found
        .filter((u) => u.file === file && u.line === line && u.symbolPath.includes('#'))
        .map((u) => `${u.symbolPath} ${u.via}`);
    expect(at('src/reader.ts', 2)).toEqual(['InternalState#ticks direct']);
    expect(at('src/reader.ts', 3)).toEqual(['Item#id direct']);
    expect(at('src/loose.ts', 2)).toEqual(['InternalState#ticks inferred']);
    expect(at('src/loose.ts', 3)).toEqual(['InternalState#ticks direct']);
    // Ambiguous by name: nothing is guessed.
    expect(at('src/loose.ts', 4)).toEqual([]);
  });
});

describe('require() and import() in a legacy consumer', () => {
  it('follows bound loads, by the checker where it can and by name where it cannot, and lists only untracked flows', async () => {
    const dir = resolve(import.meta.dirname, '../../../../../fixtures/repos/require-consumer');
    const surface = await adapter.extractSurface({
      name: 'synthetic',
      version: '1.0.0',
      dir: SYNTHETIC,
    });
    const result = await adapter.findUsages({ dir }, 'synthetic', surface);
    const rows = result.usages.map(
      (u) =>
        `${u.file}:${u.line} ${u.symbolPath} ${u.access} ${u.via} ${u.loader ?? '-'} ${u.checked === false ? 'unchecked' : 'checked'}`,
    );
    expect(rows).toEqual([
      'src/dynamic.js:3 . import require require checked',
      'src/dynamic.js:4 makeClient call direct require checked',
      'src/legacy.js:1 . import require require unchecked',
      'src/legacy.js:2 . import require require unchecked',
      'src/legacy.js:2 VERSION read destructure require unchecked',
      'src/legacy.js:4 makeClient call direct require unchecked',
      'src/legacy.js:5 VERSION read direct require unchecked',
      'src/typed.ts:3 makeClient call direct require checked',
      'src/untyped.ts:3 . import require require checked',
      'src/untyped.ts:4 . import require require checked',
      'src/untyped.ts:4 VERSION read require require checked',
      'src/untyped.ts:6 makeClient call require require checked',
      'src/untyped.ts:7 VERSION read require require checked',
    ]);
    expect(result.unanalyzed).toEqual([
      { file: 'src/legacy.js', line: 6, kind: 'require' },
      { file: 'src/untyped.ts', line: 8, kind: 'require' },
    ]);
  });
});

describe('installedPackageDir', () => {
  it('is undefined for a package that is not installed, never the repository itself', () => {
    expect(
      adapter.installedPackageDir({ dir: CONSUMER }, 'not-installed-anywhere'),
    ).toBeUndefined();
  });
});
