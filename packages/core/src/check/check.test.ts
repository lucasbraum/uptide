import { cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ts } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { createTypescriptAdapter } from '../adapters/typescript/index.js';
import { printCompilerNode } from '../adapters/typescript/serialize.js';
import type { PackageFetcher, SurfaceCache } from '../domain/io.js';
import type { ProgressEvent } from '../domain/progress.js';
import type { Finding, PackageReport } from '../domain/report.js';
import type { ApiSurface } from '../domain/surface.js';
import { UptideError } from '../errors.js';
import { fix } from '../fix/run.js';
import { isolatedPnpmWorkspace, zodFixture } from '../fix/test-fixture.js';
import { onReset } from '../shared-state.js';
import {
  check,
  mergeAcrossWorkspaces,
  sitesOf,
  statusOf,
  summarize,
  workerHeapMb,
} from './check.js';

const ROOT = resolve(import.meta.dirname, '../../../../fixtures');
const CONSUMER = join(ROOT, 'repos/synthetic-consumer');

/** A registry with one package: synthetic, latest 2.0.0, served from the fixture copy. */
const fetcher: PackageFetcher = {
  async resolve(name, requested) {
    if (name !== 'synthetic') throw new Error(`${name}: not found`);
    return requested === 'latest' ? '2.0.0' : requested;
  },
  async fetch(name, version) {
    const dir = mkdtempSync(join(tmpdir(), 'uptide-target-'));
    cpSync(join(ROOT, version === '2.0.0' ? 'synthetic-v2' : 'synthetic'), dir, {
      recursive: true,
    });
    return { name, version, dir };
  },
};

function memoryCache(): SurfaceCache {
  const store = new Map<string, ApiSurface>();
  return {
    async get(k) {
      return store.get(`${k.package}@${k.version}`);
    },
    async set(k, s) {
      store.set(`${k.package}@${k.version}`, s);
    },
  };
}

// Probe results are cached per package@version; fixture names must never land in the user's cache.
process.env.UPTIDE_CACHE_DIR = mkdtempSync(join(tmpdir(), 'uptide-test-cache-'));

const adapter = createTypescriptAdapter({ now: () => new Date('2026-09-27T00:00:00.000Z') });

it('compiles every named importer even when an unused removed binding has no attributed usage', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'uptide-scoped-import-'));
  cpSync(CONSUMER, dir, { recursive: true });
  const config = JSON.parse(readFileSync(join(dir, 'tsconfig.json'), 'utf8'));
  for (const key of Object.keys(config.compilerOptions.paths))
    config.compilerOptions.paths[key] = config.compilerOptions.paths[key].map((p: string) =>
      resolve(CONSUMER, p),
    );
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify(config));
  writeFileSync(join(dir, 'unused.ts'), "import { parseLegacy } from 'synthetic';\nexport {};\n");
  const result = await check({
    cwd: dir,
    only: ['synthetic'],
    fetcher,
    cache: memoryCache(),
    runtime: false,
  });
  expect(result.packages[0]?.findings).toContainEqual(
    expect.objectContaining({
      severity: 'breaking',
      evidence: 'compiler',
      usage: expect.objectContaining({ file: 'unused.ts', line: 1 }),
    }),
  );
});

describe('check on the synthetic consumer', () => {
  it('produces one package report with both signals and the expected findings', {
    timeout: 30_000,
  }, async () => {
    const events: ProgressEvent[] = [];
    const result = await check({
      cwd: CONSUMER,
      adapter,
      fetcher,
      cache: memoryCache(),
      onProgress: (e) => events.push(e),
    });
    for (const phase of ['resolve', 'fetch', 'usages', 'diff', 'compile', 'runtime']) {
      expect(events.some((e) => e.phase === phase && e.state === 'start')).toBe(true);
      expect(events.some((e) => e.phase === phase && e.state === 'done' && (e.ms ?? -1) >= 0)).toBe(
        true,
      );
    }
    expect(events.some((e) => e.package === 'synthetic' && e.workspace === '.')).toBe(true);
    expect(result.packages).toHaveLength(1);
    const pkg = result.packages[0] as (typeof result.packages)[number];
    expect(pkg).toMatchObject({
      name: 'synthetic',
      installed: '1.0.0',
      latest: '2.0.0',
      target: '2.0.0',
      majorsBehind: 1,
      status: 'breaking',
      callSitesChecked: 64,
    });
    expect(pkg.compile).toMatchObject({
      baselineErrors: 0,
      unresolvedInTarget: [],
      unattributed: [],
    });
    expect(pkg.notes).toEqual([]);
    const rows = pkg.findings.map(
      (f) => `${f.usage.file}:${f.usage.line} ${f.change.path} ${f.severity} ${f.fixability}`,
    );
    expect(rows).toContain('src/chains.ts:6 makeClient breaking assisted');
    // Signal B ran and did not object to the widened reads: the compiler arbitrates them down to possible runtime changes.
    expect(rows).toContain('src/direct.ts:13 ParseOptions#mode info none');
    expect(rows).toContain('src/callbacks.ts:13 ParseOptions#mode info none');
    expect(
      pkg.findings.find(
        (f) =>
          f.usage.line === 13 &&
          f.change.path === 'ParseOptions#mode' &&
          f.usage.file === 'src/direct.ts',
      ),
    ).toMatchObject({ confidence: 0.3 });
    expect(rows).toContain('src/direct.ts:13 VERSION deprecated mechanical');
    expect(pkg.findings.find((f) => f.change.path === 'makeClient')?.usage.compileError).toBe(
      'Expected 2 arguments, but got 1.',
    );
    expect(result.summary).toEqual({
      packagesNeedingAttention: 1,
      breaking: 1,
      deprecated: 1,
      unverified: 0,
      unaffected: 0,
      notImported: 0,
      partiallyAnalyzed: 0,
      autoFixable: 1,
      skippedForTime: 0,
      failed: 0,
    });
    // No pack covers `synthetic`: the breaking finding stands because the compiler confirms it.
    expect(pkg.tier).toBe('generic');
    expect(pkg.findings.filter((f) => f.severity === 'breaking').map((f) => f.evidence)).toEqual([
      'compiler',
    ]);
    expect(pkg.timing.compileMs).toBeGreaterThan(0);
  });

  it('with compile off, Signal A alone still produces the full report', async () => {
    const result = await check({
      cwd: CONSUMER,
      adapter,
      fetcher,
      cache: memoryCache(),
      compile: false,
    });
    const pkg = result.packages[0] as (typeof result.packages)[number];
    expect(pkg.compile).toBeUndefined();
    expect(pkg.timing.compileMs).toBe(0);
    // Without the compiler nothing confirms the three sites, and no pack vouches for them:
    // in the generic tier they are unverified, kept for --details, never called breaking.
    expect(result.summary.breaking).toBe(0);
    expect(result.summary.unverified).toBe(3);
    expect(pkg.findings.filter((f) => f.severity === 'unverified').map((f) => f.reason)).toEqual(
      expect.arrayContaining([expect.stringContaining('not confirmed by the compiler')]),
    );
    expect(pkg.findings.every((f) => f.usage.compileError === undefined)).toBe(true);
  });

  it('an explicit target equal to the installed version is up to date', async () => {
    const result = await check({
      cwd: CONSUMER,
      adapter,
      fetcher,
      cache: memoryCache(),
      targets: { synthetic: '1.0.0' },
    });
    const pkg = result.packages[0] as (typeof result.packages)[number];
    expect(pkg.status).toBe('safe');
    expect(pkg.notes).toEqual(['up to date']);
    expect(pkg.latest).toBe('2.0.0');
    expect(result.summary.unaffected).toBe(1);
  });
});

describe('check skips what cannot matter', () => {
  it('marks @types/* and never-imported dependencies as not-imported unless allDeps', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'uptide-deps-'));
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
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'tmp',
        dependencies: { synthetic: '1.0.0', 'left-pad': '1.3.0' },
        devDependencies: { '@types/node': '22.0.0' },
      }),
    );
    writeFileSync(
      join(dir, 'package-lock.json'),
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': {},
          'node_modules/synthetic': { version: '1.0.0' },
          'node_modules/left-pad': { version: '1.3.0' },
          'node_modules/@types/node': { version: '22.0.0' },
        },
      }),
    );
    const result = await check({
      cwd: dir,
      adapter,
      fetcher,
      cache: memoryCache(),
      compile: false,
    });
    expect(result.packages.map((p) => `${p.name}:${p.status}`)).toEqual([
      '@types/node:not-imported',
      'left-pad:not-imported',
      'synthetic:deprecated',
    ]);
    expect(result.summary.notImported).toBe(2);
    const all = await check({
      cwd: dir,
      adapter,
      fetcher,
      cache: memoryCache(),
      compile: false,
      allDeps: true,
    });
    expect(all.packages.map((p) => `${p.name}:${p.status}`)).toEqual([
      '@types/node:skipped',
      'left-pad:skipped',
      'synthetic:deprecated',
    ]);
  });
});

describe('check on a pnpm workspace', () => {
  it('runs per workspace package with its own importer, and dedups the summary by dependency', async () => {
    const root = join(ROOT, 'repos/workspace-consumer');
    const result = await check({
      cwd: root,
      adapter,
      fetcher,
      cache: memoryCache(),
      compile: false,
    });
    expect(result.workspaces).toEqual(['.', 'packages/app', 'packages/lib']);
    expect(result.packages.map((p) => `${p.workspace} ${p.name}:${p.status}`)).toEqual([
      '. left-pad:not-imported',
      'packages/app lib:workspace',
      'packages/app synthetic:deprecated',
    ]);
    const app = result.packages.find(
      (p) => p.name === 'synthetic',
    ) as (typeof result.packages)[number];
    expect(
      app.findings.map((f) => `${f.usage.file}:${f.usage.line} ${f.change.path} ${f.severity}`),
    ).toEqual(['src/index.ts:4 makeClient unverified', 'src/index.ts:6 VERSION deprecated']);
    // This run compiles nothing, so the generic tier calls nothing breaking.
    expect(result.summary).toMatchObject({
      packagesNeedingAttention: 1,
      breaking: 0,
      unverified: 1,
      deprecated: 1,
      notImported: 1,
    });
  });
});

describe('check on a workspace that imports what it does not declare', () => {
  it('analyzes the importer against the copy it resolves, names where it comes from, and lists an importer it cannot resolve', async () => {
    // app imports synthetic but only lib declares it; app reaches it through lib (workspace:*),
    // like a Next app importing stripe through the core package that declares it.
    const root = mkdtempSync(join(tmpdir(), 'uptide-undeclared-'));
    cpSync(join(ROOT, 'repos/workspace-consumer'), root, { recursive: true });
    const edit = (file: string, change: (json: Record<string, unknown>) => void): void => {
      const json = JSON.parse(readFileSync(join(root, file), 'utf8')) as Record<string, unknown>;
      change(json);
      writeFileSync(join(root, file), JSON.stringify(json, null, 2));
    };
    edit('packages/app/package.json', (j) => {
      j.dependencies = { lib: 'workspace:*' };
    });
    edit('packages/lib/package.json', (j) => {
      j.dependencies = { synthetic: '1.0.0' };
    });
    writeFileSync(
      join(root, 'pnpm-lock.yaml'),
      readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8')
        .replace('      synthetic:\n        specifier: 1.0.0\n        version: 1.0.0\n', '')
        .concat(
          '\n  packages/lib:\n    dependencies:\n      synthetic:\n        specifier: 1.0.0\n        version: 1.0.0\n',
        ),
    );
    // Hoisted, as a shamefully-hoist install leaves it: that is the copy app resolves.
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    symlinkSync(join(ROOT, 'synthetic'), join(root, 'node_modules/synthetic'), 'dir');
    writeFileSync(
      join(root, 'packages/lib/src/index.ts'),
      "import { VERSION } from 'synthetic';\nexport const old = VERSION;\n",
    );
    // The root imports a package nothing declares and nothing resolves.
    writeFileSync(join(root, 'scripts/root.ts'), "import 'ghost';\nexport const root = 1;\n");
    const result = await check({
      cwd: root,
      adapter,
      fetcher,
      cache: memoryCache(),
      compile: false,
      only: ['synthetic', 'ghost'],
    });
    const synthetic = result.packages.find((p) => p.name === 'synthetic') as PackageReport;
    expect(synthetic.workspaces).toEqual(['packages/app', 'packages/lib']);
    expect(synthetic.importers).toEqual([
      { workspace: 'packages/app', declared: false, via: 'lib', analyzed: true },
      { workspace: 'packages/lib', declared: true, analyzed: true },
    ]);
    expect(
      synthetic.findings.map(
        (f) => `${f.usage.file}:${f.usage.line} ${f.change.path} ${f.severity}`,
      ),
    ).toEqual([
      'packages/app/src/index.ts:4 makeClient unverified',
      'packages/app/src/index.ts:6 VERSION deprecated',
      'packages/lib/src/index.ts:2 VERSION deprecated',
    ]);
    const ghost = result.packages.find((p) => p.name === 'ghost') as PackageReport;
    expect(ghost).toMatchObject({ workspace: '.', status: 'skipped', undeclared: {} });
    expect(ghost.importers).toEqual([
      {
        workspace: '.',
        declared: false,
        analyzed: false,
        reason: 'imports ghost without declaring it, and it does not resolve from .',
      },
    ]);
  });
});

describe('mergeAcrossWorkspaces', () => {
  const base = (
    workspace: string,
    name: string,
    over: Partial<PackageReport> = {},
  ): PackageReport => ({
    workspace,
    name,
    installed: '1.0.0',
    latest: '2.0.0',
    target: '2.0.0',
    majorsBehind: 1,
    findings: [],
    callSitesChecked: 1,
    unanalyzed: [],
    status: 'safe',
    notes: [],
    timing: { fetchMs: 0, diffMs: 0, usagesMs: 0, compileMs: 0 },
    ...over,
  });

  it('merges the same dependency at the same versions across workspaces, and marks catalog entries', () => {
    const out = mergeAcrossWorkspaces(
      [
        base('packages/api', 'zod', { callSitesChecked: 5 }),
        base('packages/shared', 'zod', { callSitesChecked: 7, status: 'deprecated' }),
        base('packages/api', 'stripe'),
        base('packages/api', 'other'),
        base('packages/shared', 'other', { installed: '0.9.0' }),
      ],
      { 'packages/api': ['stripe'] },
    );
    expect(out.map((p) => `${p.workspace} ${p.name}${p.source ? ` ${p.source}` : ''}`)).toEqual([
      '* zod',
      '* stripe catalog',
      'packages/api other',
      'packages/shared other',
    ]);
    expect(out[0]).toMatchObject({
      workspaces: ['packages/api', 'packages/shared'],
      callSitesChecked: 12,
      status: 'safe',
    });
  });
});

describe('summarize', () => {
  it('counts an anchor by the errors under it, never as a site of its own', () => {
    const finding = (kind: 'removed' | 'cause', downstream?: number): Finding => ({
      change: {
        package: 'p',
        from: '1',
        to: '2',
        path: 'x',
        kind,
        severity: 'breaking',
        source: 'types',
        confidence: 1,
      },
      usage: {
        file: 'src/a.ts',
        line: 1,
        column: 1,
        endLine: 1,
        endColumn: 2,
        symbolPath: 'x',
        access: 'read',
        snippet: '',
        via: 'direct',
      },
      severity: 'breaking',
      confidence: 1,
      fixability: 'unknown',
      reason: '',
      ...(downstream === undefined
        ? {}
        : {
            downstream: Array.from({ length: downstream }, (_, i) => ({
              file: 'src/b.ts',
              line: i + 1,
              code: 1,
              message: '',
            })),
          }),
    });
    const pkg: PackageReport = {
      workspace: '.',
      name: 'p',
      installed: '1',
      latest: '2',
      target: '2',
      majorsBehind: 1,
      findings: [finding('removed'), finding('cause', 31)],
      callSitesChecked: 5,
      unanalyzed: [],
      status: 'breaking',
      notes: [],
      timing: { fetchMs: 0, diffMs: 0, usagesMs: 0, compileMs: 0 },
    };
    expect(summarize([pkg]).breaking).toBe(32);
    expect(sitesOf(finding('cause', 0))).toBe(0);
  });
});

describe('statusOf', () => {
  it('is safe only when every site was analyzed; partial up to a fifth unanalyzed; unknown above', () => {
    expect(statusOf([], 10, 0)).toBe('safe');
    expect(statusOf([], 10, 2)).toBe('partial');
    expect(statusOf([], 4, 4)).toBe('unknown');
    expect(statusOf([], 0, 1)).toBe('unknown');
  });
});

describe('check on a legacy require() consumer', () => {
  it('reports a package that went ESM-only at every require() site, and keeps the diff verdict on unchecked files', async () => {
    // Installed: synthetic v1 as a CommonJS release. Target: v2 as ESM-only. Same declarations.
    const cjs = mkdtempSync(join(tmpdir(), 'uptide-cjs-'));
    cpSync(join(ROOT, 'synthetic'), cjs, { recursive: true });
    const v1 = JSON.parse(readFileSync(join(cjs, 'package.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    delete v1.type;
    delete v1.exports;
    writeFileSync(
      join(cjs, 'package.json'),
      JSON.stringify({ ...v1, main: './dist/index.js', types: './dist/index.d.ts' }),
    );
    const esm = mkdtempSync(join(tmpdir(), 'uptide-esm-'));
    cpSync(join(ROOT, 'synthetic-v2'), esm, { recursive: true });
    const v2 = JSON.parse(readFileSync(join(esm, 'package.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    writeFileSync(
      join(esm, 'package.json'),
      JSON.stringify({
        ...v2,
        type: 'module',
        exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
      }),
    );
    const consumer = mkdtempSync(join(tmpdir(), 'uptide-require-'));
    cpSync(join(ROOT, 'repos/require-consumer'), consumer, { recursive: true });
    const tsconfig = JSON.parse(readFileSync(join(consumer, 'tsconfig.json'), 'utf8')) as {
      compilerOptions: { paths: Record<string, string[]> };
    };
    tsconfig.compilerOptions.paths = { synthetic: [join(cjs, 'dist/index.d.ts')] };
    writeFileSync(join(consumer, 'tsconfig.json'), JSON.stringify(tsconfig));
    // The repository pins Node 22.11: an explicit minor below 22.12, so no require(esm).
    const manifest = JSON.parse(readFileSync(join(consumer, 'package.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    writeFileSync(
      join(consumer, 'package.json'),
      JSON.stringify({ ...manifest, engines: { node: '22.11' } }),
    );
    const esmFetcher: PackageFetcher = {
      ...fetcher,
      async fetch(name, version) {
        return version === '2.0.0' ? { name, version, dir: esm } : fetcher.fetch(name, version);
      },
    };
    const result = await check({
      cwd: consumer,
      adapter,
      fetcher: esmFetcher,
      cache: memoryCache(),
    });
    const pkg = result.packages.find((p) => p.name === 'synthetic') as PackageReport;
    expect(pkg.status).toBe('breaking');
    const format = pkg.findings.filter((f) => f.change.kind === 'module-format');
    // One finding per file, listing every require() line in it.
    expect(
      format.map(
        (f) =>
          `${f.usage.file}:${f.usage.line} ${f.severity} [${f.sites?.map((s) => s.line).join(',')}]`,
      ),
    ).toEqual([
      'src/dynamic.js:3 breaking [3,4]',
      'src/legacy.js:1 breaking [1,2,4,5]',
      'src/typed.ts:3 breaking [3]',
      'src/untyped.ts:3 breaking [3,4,6,7]',
    ]);
    expect(format[0]?.reason).toMatch(/no longer loadable with require\(\)/);
    // `makeClient` gained a required parameter: on legacy.js the compiler never looked.
    const legacy = pkg.findings.find(
      (f) =>
        f.usage.file === 'src/legacy.js' && f.usage.line === 4 && f.change.path === 'makeClient',
    );
    // The repository does not type-check legacy.js, and the fixture has no runnable code for
    // the probe to load: the runtime arbiter cannot confirm, so the verdict is unverified.
    expect(legacy?.severity).toBe('unverified');
    expect(legacy?.reason).toMatch(/runtime probe was inconclusive/);
    expect(pkg.unanalyzed.map((u) => `${u.file}:${u.line}`)).toEqual([
      'src/legacy.js:6',
      'src/untyped.ts:8',
    ]);
  });
});

describe('types via @types/<name>', () => {
  it('diffs the @types release of the target major and reports under the runtime package', async () => {
    const DEPS = join(ROOT, 'deps');
    const repo = mkdtempSync(join(tmpdir(), 'uptide-types-'));
    mkdirSync(join(repo, 'src'), { recursive: true });
    mkdirSync(join(repo, 'node_modules/@types'), { recursive: true });
    cpSync(join(DEPS, 'plain-v1'), join(repo, 'node_modules/plain'), { recursive: true });
    cpSync(join(DEPS, 'types-plain-v1'), join(repo, 'node_modules/@types/plain'), {
      recursive: true,
    });
    writeFileSync(
      join(repo, 'package.json'),
      JSON.stringify({
        name: 'types-consumer',
        version: '0.1.0',
        dependencies: { plain: '1.0.0' },
        devDependencies: { '@types/plain': '1.0.0' },
      }),
    );
    writeFileSync(
      join(repo, 'package-lock.json'),
      JSON.stringify({
        name: 'types-consumer',
        lockfileVersion: 3,
        packages: {
          '': { dependencies: { plain: '1.0.0' }, devDependencies: { '@types/plain': '1.0.0' } },
          'node_modules/plain': { version: '1.0.0' },
          'node_modules/@types/plain': { version: '1.0.0' },
        },
      }),
    );
    writeFileSync(
      join(repo, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'CommonJS',
          moduleResolution: 'Node',
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          types: [],
        },
        include: ['src'],
      }),
    );
    writeFileSync(
      join(repo, 'src/index.ts'),
      "import { hello } from 'plain';\n\nexport const s: string = hello('world');\n",
    );
    const typesFetcher: PackageFetcher = {
      async resolve(name, requested) {
        if (name === 'plain') return requested === 'latest' ? '2.0.0' : requested;
        throw new Error(`${name}: not found`);
      },
      async versions(name) {
        return name === '@types/plain' ? ['1.0.0', '1.0.1', '2.0.0'] : [];
      },
      async fetch(name, version) {
        const dir = mkdtempSync(join(tmpdir(), 'uptide-plain-'));
        cpSync(
          join(DEPS, `${name === '@types/plain' ? 'types-plain' : 'plain'}-v${version[0]}`),
          dir,
          { recursive: true },
        );
        return { name, version, dir };
      },
    };
    const result = await check({ cwd: repo, adapter, fetcher: typesFetcher, cache: memoryCache() });
    const plain = result.packages.find((p) => p.name === 'plain') as PackageReport;
    expect(plain.typesVia).toBe('@types/plain 1.0.0 → 2.0.0');
    expect(plain.status).toBe('breaking');
    expect(
      plain.findings.map(
        (f) => `${f.usage.file}:${f.usage.line} ${f.change.path} ${f.change.kind} ${f.severity}`,
      ),
    ).toEqual(['src/index.ts:3 hello signature breaking']);
    expect(plain.findings[0]?.usage.compileError).toMatch(/Expected 2 arguments/);
    // The @types package itself is a type-only dependency: never listed on its own.
    expect(result.packages.find((p) => p.name === '@types/plain')?.status).toBe('not-imported');
  });
});

describe('the @types baseline follows the installed runtime', () => {
  it('compares from the @types release of the runtime major when a newer @types is installed, and warns', async () => {
    const DEPS = join(ROOT, 'deps');
    const repo = mkdtempSync(join(tmpdir(), 'uptide-types-mismatch-'));
    mkdirSync(join(repo, 'src'), { recursive: true });
    mkdirSync(join(repo, 'node_modules/@types'), { recursive: true });
    cpSync(join(DEPS, 'plain-v1'), join(repo, 'node_modules/plain'), { recursive: true });
    // The repository already has @types/plain 2 while plain 1 runs.
    cpSync(join(DEPS, 'types-plain-v2'), join(repo, 'node_modules/@types/plain'), {
      recursive: true,
    });
    writeFileSync(
      join(repo, 'package.json'),
      JSON.stringify({
        name: 'c',
        version: '0.1.0',
        dependencies: { plain: '1.0.0' },
        devDependencies: { '@types/plain': '2.0.0' },
      }),
    );
    writeFileSync(
      join(repo, 'package-lock.json'),
      JSON.stringify({
        name: 'c',
        lockfileVersion: 3,
        packages: {
          '': { dependencies: { plain: '1.0.0' }, devDependencies: { '@types/plain': '2.0.0' } },
          'node_modules/plain': { version: '1.0.0' },
          'node_modules/@types/plain': { version: '2.0.0' },
        },
      }),
    );
    writeFileSync(
      join(repo, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'CommonJS',
          moduleResolution: 'Node',
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          types: [],
        },
        include: ['src'],
      }),
    );
    writeFileSync(
      join(repo, 'src/index.ts'),
      "import { hello } from 'plain';\n\nexport const s: string = hello('world', 'hi');\n",
    );
    const typesFetcher: PackageFetcher = {
      async resolve(name, requested) {
        if (name === 'plain') return requested === 'latest' ? '2.0.0' : requested;
        throw new Error(`${name}: not found`);
      },
      async versions(name) {
        return name === '@types/plain' ? ['1.0.0', '2.0.0'] : [];
      },
      async fetch(name, version) {
        const dir = mkdtempSync(join(tmpdir(), 'uptide-plain-'));
        cpSync(
          join(DEPS, `${name === '@types/plain' ? 'types-plain' : 'plain'}-v${version[0]}`),
          dir,
          { recursive: true },
        );
        return { name, version, dir };
      },
    };
    const result = await check({ cwd: repo, adapter, fetcher: typesFetcher, cache: memoryCache() });
    const plain = result.packages.find((p) => p.name === 'plain') as PackageReport;
    expect(plain.typesVia).toBe('@types/plain 1.0.0 → 2.0.0');
    expect(plain.notes).toContainEqual(
      '@types/plain 2.0.0 is installed while plain 1.0.0 runs; baseline taken as @types/plain 1.0.0',
    );
    // From 1.0.0's `hello(name)` to 2.0.0's `hello(name, greeting)`: the change is seen again, and
    // the call already passes two arguments, so the compiler does not object: info, not breaking.
    expect(plain.findings.map((f) => `${f.change.path} ${f.change.kind} ${f.severity}`)).toEqual([
      'hello signature info',
    ]);
  });
});

describe('an untyped installed version gaining types', () => {
  it('reports the target-only type errors as unverified, with the reason', async () => {
    const DEPS = join(ROOT, 'deps');
    const repo = mkdtempSync(join(tmpdir(), 'uptide-untyped-'));
    mkdirSync(join(repo, 'src'), { recursive: true });
    cpSync(join(DEPS, 'plain-v1'), join(repo, 'node_modules/plain'), { recursive: true });
    writeFileSync(
      join(repo, 'package.json'),
      JSON.stringify({
        name: 'u',
        version: '0.1.0',
        dependencies: { plain: '1.0.0' },
        engines: { node: '>=22' },
      }),
    );
    writeFileSync(
      join(repo, 'package-lock.json'),
      JSON.stringify({
        name: 'u',
        lockfileVersion: 3,
        packages: {
          '': { dependencies: { plain: '1.0.0' } },
          'node_modules/plain': { version: '1.0.0' },
        },
      }),
    );
    writeFileSync(
      join(repo, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'CommonJS',
          moduleResolution: 'Node',
          allowJs: true,
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          types: [],
        },
        include: ['src'],
      }),
    );
    writeFileSync(
      join(repo, 'src/index.js'),
      "const { hello } = require('plain');\n\nmodule.exports = hello('world');\n",
    );
    const typedFetcher: PackageFetcher = {
      async resolve(name, requested) {
        if (name === 'plain') return requested === 'latest' ? '2.0.0' : requested;
        throw new Error(`${name}: not found`);
      },
      async fetch(name, version) {
        const dir = mkdtempSync(join(tmpdir(), 'uptide-plain-'));
        cpSync(join(DEPS, version === '2.0.0' ? 'plain-typed-v2' : 'plain-v1'), dir, {
          recursive: true,
        });
        return { name, version, dir };
      },
    };
    const result = await check({ cwd: repo, adapter, fetcher: typedFetcher, cache: memoryCache() });
    const plain = result.packages.find((p) => p.name === 'plain') as PackageReport;
    expect(plain.status).toBe('no-types');
    const errors = plain.findings.filter((f) => /^TS\d+$/.test(f.change.path));
    expect(errors.map((f) => `${f.usage.line} ${f.change.path} ${f.severity}`)).toEqual([
      '3 TS2554 info',
    ]);
    // The repository does not type-check src/index.js; the probe saw `hello` survive, so the
    // compiler's arity complaint is information, not a break.
    expect(errors[0]?.reason).toMatch(/does not type-check this file, and the target loads/);
    // Signal C loaded both copies: 1.0.0 exports a function with `legacy`, 2.0.0 a plain object without it.
    const runtime = plain.runtime?.[0];
    expect(runtime?.package).toBe('plain');
    expect(runtime?.inconclusive).toBeUndefined();
    expect(runtime?.changes.map((c) => `${c.loader}:${c.kind}${c.key ? `:${c.key}` : ''}`)).toEqual(
      ['require:callable-lost', 'require:key-removed:legacy', 'import:key-removed:legacy'],
    );
    expect(plain.timing.runtimeMs).toBeGreaterThanOrEqual(0);
  });

  it('skips Signal C when runtime is off', async () => {
    const DEPS = join(ROOT, 'deps');
    const repo = mkdtempSync(join(tmpdir(), 'uptide-untyped-'));
    mkdirSync(join(repo, 'src'), { recursive: true });
    cpSync(join(DEPS, 'plain-v1'), join(repo, 'node_modules/plain'), { recursive: true });
    writeFileSync(
      join(repo, 'package.json'),
      JSON.stringify({ name: 'u', version: '0.1.0', dependencies: { plain: '1.0.0' } }),
    );
    writeFileSync(
      join(repo, 'package-lock.json'),
      JSON.stringify({
        name: 'u',
        lockfileVersion: 3,
        packages: {
          '': { dependencies: { plain: '1.0.0' } },
          'node_modules/plain': { version: '1.0.0' },
        },
      }),
    );
    writeFileSync(
      join(repo, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { allowJs: true, noEmit: true, types: [] },
        include: ['src'],
      }),
    );
    writeFileSync(
      join(repo, 'src/index.js'),
      "const { hello } = require('plain');\nmodule.exports = hello('w');\n",
    );
    const fetcher: PackageFetcher = {
      async resolve(name, requested) {
        if (name === 'plain') return requested === 'latest' ? '2.0.0' : requested;
        throw new Error(`${name}: not found`);
      },
      async fetch(name, version) {
        const dir = mkdtempSync(join(tmpdir(), 'uptide-plain-'));
        cpSync(join(DEPS, version === '2.0.0' ? 'plain-v2' : 'plain-v1'), dir, { recursive: true });
        return { name, version, dir };
      },
    };
    const result = await check({
      cwd: repo,
      adapter,
      fetcher,
      cache: memoryCache(),
      runtime: false,
    });
    const plain = result.packages.find((p) => p.name === 'plain') as PackageReport;
    expect(plain.runtime).toBeUndefined();
    expect(plain.timing.runtimeMs).toBeUndefined();
  });
});

it('preserves a machine-readable registry failure independently of message wording', async () => {
  const result = await check({
    cwd: CONSUMER,
    adapter,
    cache: memoryCache(),
    fetcher: {
      ...fetcher,
      resolve: async () => {
        throw new UptideError('REGISTRY_UNREACHABLE', 'offline');
      },
    },
  });
  expect(result.packages[0]).toMatchObject({
    status: 'skipped',
    skipReason: 'REGISTRY_UNREACHABLE',
  });
});

describe('a time budget and one failing dependency', () => {
  it('skips what the budget does not reach and says so, without failing', async () => {
    const result = await check({
      cwd: CONSUMER,
      adapter,
      fetcher,
      cache: memoryCache(),
      // Already spent when the first dependency would start.
      maxTimeMs: 1,
    });
    expect(result.packages.find((p) => p.name === 'synthetic')).toMatchObject({
      status: 'skipped',
      skipReason: 'TIME_BUDGET',
      tier: 'generic',
      findings: [],
    });
    expect(result.summary).toMatchObject({ skippedForTime: 1, failed: 0, breaking: 0 });
  });

  it('does not skip what is up to date: there is nothing to analyze there', async () => {
    const result = await check({
      cwd: CONSUMER,
      adapter,
      fetcher,
      cache: memoryCache(),
      targets: { synthetic: '1.0.0' },
      maxTimeMs: 60_000,
    });
    expect(result.packages.find((p) => p.name === 'synthetic')?.notes).toEqual(['up to date']);
    expect(result.summary.skippedForTime).toBe(0);
  });

  it('reports a dependency whose analysis fails as failed, with the reason', async () => {
    const result = await check({
      cwd: CONSUMER,
      adapter,
      cache: memoryCache(),
      fetcher: {
        ...fetcher,
        fetch: async () => {
          throw new UptideError('REGISTRY_HTTP_ERROR', 'tarball: HTTP 503');
        },
      },
    });
    expect(result.packages.find((p) => p.name === 'synthetic')).toMatchObject({
      status: 'skipped',
      skipReason: 'REGISTRY_HTTP_ERROR',
    });
    expect(result.summary).toMatchObject({ failed: 1, skippedForTime: 0 });
  });
});

it('caps the worker heap at 60% of free memory including native overhead, even with an override', () => {
  const GB = 1024 ** 3;
  expect(workerHeapMb(2, 8 * GB, {})).toBe(1755);
  expect(workerHeapMb(2, 18 * GB, {})).toBe(3949);
  expect(workerHeapMb(1, 64 * GB, {})).toBe(8192);
  expect(workerHeapMb(2, 18 * GB, { UPTIDE_WORKER_HEAP_MB: '12000' })).toBe(3949);
  expect(workerHeapMb(2, 18 * GB, { UPTIDE_WORKER_HEAP_MB: '1024' })).toBe(1024);
});

it('turns recursive extraction failure into an explicit per-package failure', async () => {
  const result = await check({
    cwd: CONSUMER,
    adapter: {
      ...adapter,
      extractSurface: async () => {
        throw new RangeError('Maximum call stack size exceeded');
      },
    },
    fetcher,
    cache: memoryCache(),
    runtime: false,
  });
  expect(result.packages.find((p) => p.name === 'synthetic')).toMatchObject({
    status: 'skipped',
    skipReason: 'ANALYSIS_STACK_OVERFLOW',
  });
  expect(result.packages[0]?.notes.join(' ')).toContain('No safety verdict');
  expect(result.summary.failed).toBe(1);
});

describe('recursive declarations (uptide-dev/uptide#4)', () => {
  /** A consumer of logkit (pino-like, recursive) and widget, both installed at 1.0.0. */
  function consumer(): string {
    const DEPS = join(ROOT, 'deps');
    const repo = mkdtempSync(join(tmpdir(), 'uptide-recursive-'));
    mkdirSync(join(repo, 'src'), { recursive: true });
    cpSync(join(DEPS, 'recursive-v1'), join(repo, 'node_modules/logkit'), { recursive: true });
    cpSync(join(DEPS, 'widget-v1'), join(repo, 'node_modules/widget'), { recursive: true });
    const deps = { logkit: '1.0.0', widget: '1.0.0' };
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'app', dependencies: deps }));
    writeFileSync(
      join(repo, 'package-lock.json'),
      JSON.stringify({
        name: 'app',
        lockfileVersion: 3,
        packages: {
          '': { dependencies: deps },
          'node_modules/logkit': { version: '1.0.0' },
          'node_modules/widget': { version: '1.0.0' },
        },
      }),
    );
    writeFileSync(
      join(repo, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          noEmit: true,
          skipLibCheck: true,
        },
        include: ['src'],
      }),
    );
    writeFileSync(
      join(repo, 'src/index.ts'),
      [
        "import logkit = require('logkit');",
        "import { boxed } from 'widget';",
        'const log = logkit();',
        'export const parent = log.parent;',
        'export const child = log.child({}).level;',
        'export const value = boxed().a;',
        '',
      ].join('\n'),
    );
    return repo;
  }
  const recursiveFetcher: PackageFetcher = {
    async resolve(_name, requested) {
      return requested === 'latest' ? '2.0.0' : requested;
    },
    async versions() {
      return [];
    },
    async fetch(name, version) {
      const dir = mkdtempSync(join(tmpdir(), `uptide-${name}-`));
      cpSync(
        join(
          ROOT,
          'deps',
          name === 'logkit' ? `recursive-v${version[0]}` : `widget-v${version[0]}`,
        ),
        dir,
        {
          recursive: true,
        },
      );
      return { name, version, dir };
    },
  };

  it('analyzes a package whose namespace exports itself, and finds the real break', async () => {
    const result = await check({
      cwd: consumer(),
      only: ['logkit'],
      adapter,
      fetcher: recursiveFetcher,
      cache: memoryCache(),
      runtime: false,
    });
    const logkit = result.packages.find((p) => p.name === 'logkit') as PackageReport;
    expect(logkit.status).toBe('breaking');
    expect(logkit.skipReason).toBeUndefined();
    expect(
      logkit.findings.map(
        (f) => `${f.change.kind} ${f.change.path} ${f.usage.file}:${f.usage.line}`,
      ),
    ).toContain('removed logkit.Logger#parent src/index.ts:4');
  });

  it("leaves no state behind: after a package fails mid-print, the next one's report is byte-identical to its own run", async () => {
    // A failure inside the shared printer (what a stack overflow did on main), then logkit.
    const f = ts.factory;
    const boom = f.createIdentifier('Boom');
    Object.defineProperty(boom, 'escapedText', {
      get() {
        throw new RangeError('Maximum call stack size exceeded');
      },
    });
    const failing = f.createTypeReferenceNode('Partial', [f.createTypeReferenceNode(boom)]);
    const run = (only: string[]) =>
      check({
        cwd: consumer(),
        only,
        order: ['widget', 'logkit'],
        concurrency: 1,
        adapter: {
          ...adapter,
          extractSurface: async (pkg) => {
            if (pkg.name === 'widget') printCompilerNode(failing);
            return adapter.extractSurface(pkg);
          },
        },
        fetcher: recursiveFetcher,
        cache: memoryCache(),
        runtime: false,
      });
    // Timings and temporary directories differ between any two runs; nothing else may.
    const stable = (report: PackageReport | undefined) =>
      JSON.stringify(report, (key, value) =>
        key === 'timing' || key === 'ms' ? undefined : value,
      ).replace(/\/[^"]*uptide-[^"/]*/g, '<tmp>');
    const after = await run(['widget', 'logkit']);
    expect(after.packages.find((p) => p.name === 'widget')?.skipReason).toBe(
      'ANALYSIS_STACK_OVERFLOW',
    );
    const alone = await run(['logkit']);
    expect(stable(after.packages.find((p) => p.name === 'logkit'))).toBe(
      stable(alone.packages.find((p) => p.name === 'logkit')),
    );
  });

  it("leaves no state behind after a failed fix: the next package's check is byte-identical to its own run", async () => {
    let resets = 0;
    onReset(() => {
      resets++;
    });
    const f = ts.factory;
    const boom = f.createIdentifier('Boom');
    Object.defineProperty(boom, 'escapedText', {
      get() {
        throw new RangeError('Maximum call stack size exceeded');
      },
    });
    const checkLogkit = () =>
      check({
        cwd: consumer(),
        only: ['logkit'],
        adapter,
        fetcher: recursiveFetcher,
        cache: memoryCache(),
        runtime: false,
      });
    const stable = (report: PackageReport | undefined) =>
      JSON.stringify(report, (key, value) =>
        key === 'timing' || key === 'ms' ? undefined : value,
      ).replace(/\/[^"]*uptide-[^"/]*/g, '<tmp>');
    const alone = stable((await checkLogkit()).packages.find((p) => p.name === 'logkit'));
    // As the Action does: fix one detected upgrade, then check the next. This fix fails
    // inside TypeScript's printer while analyzing zod.
    const { root, services } = zodFixture(mkdtempSync(join(tmpdir(), 'uptide-failing-fix-')));
    const before = resets;
    await expect(
      fix(
        { cwd: root, only: 'zod', fixer: null },
        {
          ...services,
          check: async () => {
            printCompilerNode(
              f.createTypeReferenceNode('Partial', [f.createTypeReferenceNode(boom)]),
            );
            throw new Error('unreachable');
          },
        },
      ),
    ).rejects.toThrow('Maximum call stack size exceeded');
    expect(resets).toBe(before + 1);
    expect(stable((await checkLogkit()).packages.find((p) => p.name === 'logkit'))).toBe(alone);
  });

  it('fails a package alone: the others keep their results, and the failure says which and why', async () => {
    const result = await check({
      cwd: consumer(),
      only: ['logkit', 'widget'],
      adapter: {
        ...adapter,
        extractSurface: async (pkg) => {
          if (pkg.name === 'widget') throw new RangeError('Maximum call stack size exceeded');
          return adapter.extractSurface(pkg);
        },
      },
      fetcher: recursiveFetcher,
      cache: memoryCache(),
      runtime: false,
    });
    expect(result.packages.find((p) => p.name === 'widget')).toMatchObject({
      status: 'skipped',
      skipReason: 'ANALYSIS_STACK_OVERFLOW',
      notes: [
        expect.stringMatching(/^widget: analysis exceeded its recursion limit .*No safety verdict/),
      ],
    });
    expect(result.packages.find((p) => p.name === 'logkit')?.status).toBe('breaking');
    expect(result.summary.failed).toBe(1);
  });
});

describe('check on a pnpm workspace with the isolated node-linker', () => {
  it("compiles each workspace with its own @types: a baseline of 0, as the workspace's tsc has", async () => {
    // Nothing hoisted: @types/node is only in each package's node_modules. Types read from the
    // process's directory would make Buffer and node:crypto "pre-existing" errors here.
    const root = isolatedPnpmWorkspace(mkdtempSync(join(tmpdir(), 'uptide-isolated-check-')));
    const greetFetcher: PackageFetcher = {
      async resolve(name, requested) {
        if (name === 'greet') return requested === 'latest' ? '2.0.0' : requested;
        throw new Error(`${name}: not found`);
      },
      async versions() {
        return [];
      },
      async fetch(name, version) {
        const dir = mkdtempSync(join(tmpdir(), 'uptide-greet-'));
        cpSync(
          join(
            root,
            version === '2.0.0'
              ? 'greet-2.0.0'
              : 'node_modules/.pnpm/greet@1.0.0/node_modules/greet',
          ),
          dir,
          {
            recursive: true,
          },
        );
        return { name, version, dir };
      },
    };
    const result = await check({
      cwd: root,
      only: ['greet'],
      adapter,
      fetcher: greetFetcher,
      cache: memoryCache(),
      runtime: false,
    });
    // One dependency at one version in both packages: one report, compiled per workspace.
    const greet = result.packages.find((p) => p.name === 'greet') as PackageReport;
    expect(greet.workspaces).toEqual(['packages/a', 'packages/b']);
    expect(greet.compile?.skipped).toBeUndefined();
    expect(greet.compile?.baselineErrors).toBe(0);
    expect(
      greet.findings.map((f) => `${f.usage.file}:${f.usage.line} ${f.severity}`).sort(),
    ).toEqual(['packages/a/index.ts:6 breaking', 'packages/b/index.ts:6 breaking']);
  });
});
