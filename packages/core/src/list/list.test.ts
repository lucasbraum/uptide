import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { listDependencies } from './list.js';
import { scanImports } from './scan.js';

const roots: string[] = [];
const fixture = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'uptide-discovery-'));
  roots.push(root);
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'app',
      dependencies: { zod: '3.25.76', minor: '1.0.0', tool: '1.0.0', missing: '1.0.0' },
    }),
  );
  writeFileSync(
    join(root, 'index.tsx'),
    `import { z as schema } from 'zod';
import type { ZodType } from 'zod';
import Minor from 'minor/subpath';
schema.string(); new Minor(); <Minor />;
// import ghost from 'tool';
const text = "require('tool')";
`,
  );
  return root;
};
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('discovers without installation, resolves metadata once per name and retains failures', async () => {
  const cwd = fixture();
  const resolve = vi.fn(async (name: string) => {
    if (name === 'missing') throw new Error('registry unavailable');
    return name === 'zod' ? '4.6.5' : name === 'minor' ? '1.1.0' : '2.0.0';
  });
  const result = await listDependencies({ cwd, fetcher: { resolve } });
  expect(resolve).toHaveBeenCalledTimes(4);
  expect(result.packages.map((p) => p.name)).toEqual(['zod', 'tool', 'minor']);
  expect(result.packages[0]).toMatchObject({
    current: '3.25.76',
    change: 'major',
    tier: 'verified',
    workspaces: ['.'],
    usage: {
      files: 1,
      callSites: 1,
      topSymbols: [{ name: 'z.string', count: 1 }],
    },
  });
  expect(result.packages[1]?.usage.files).toBe(0);
  expect(result.packages[2]?.usage.callSites).toBe(2);
  expect(result.failures).toEqual([{ name: 'missing', reason: 'registry unavailable' }]);
  expect((await listDependencies({ cwd, fetcher: { resolve } })).packages).toEqual(result.packages);
});

it('recognizes literal import forms, skips comments, generated files and symlink cycles', async () => {
  const cwd = fixture();
  mkdirSync(join(cwd, 'node_modules'));
  writeFileSync(join(cwd, 'node_modules', 'ignored.ts'), "import x from 'tool'; x();");
  symlinkSync(cwd, join(cwd, 'cycle'), 'dir');
  writeFileSync(
    join(cwd, 'other.cts'),
    `import z = require('zod'); z.string();
const { make: build } = require('other'); build();
const mod = await import('dynamic/subpath'); mod.run();
export { x } from 'reexport';
`,
  );
  const scan = await scanImports(cwd, ['zod', 'tool', 'other', 'dynamic', 'reexport'], ['.']);
  expect(scan.get('zod')?.callSites).toBe(2);
  expect(scan.get('tool')).toBeUndefined();
  expect(scan.get('other')?.symbols.make).toBe(1);
  expect(scan.get('dynamic')?.symbols.run).toBe(1);
  expect(scan.get('reexport')?.files).toEqual(['other.cts']);
});

it('deduplicates names across workspaces, skips internal names and keeps distinct current versions', async () => {
  const cwd = fixture();
  mkdirSync(join(cwd, 'packages/a'), { recursive: true });
  writeFileSync(
    join(cwd, 'package.json'),
    JSON.stringify({
      name: 'root',
      workspaces: ['packages/*'],
      dependencies: { zod: '3.25.76', internal: '*' },
    }),
  );
  writeFileSync(
    join(cwd, 'packages/a/package.json'),
    JSON.stringify({ name: 'internal', dependencies: { zod: '3.24.0' } }),
  );
  writeFileSync(join(cwd, 'packages/a/use.ts'), "import { z } from 'zod'; z.string();");
  const resolve = vi.fn(async () => '4.6.5');
  const result = await listDependencies({ cwd, fetcher: { resolve } });
  expect(resolve).toHaveBeenCalledTimes(1);
  expect(result.failures).toEqual([]);
  expect(result.packages.map((p) => p.current)).toEqual(['3.24.0', '3.25.76']);
  expect(result.packages[0]?.usage.workspaces).toEqual(['.', 'packages/a']);
});

const nestRoot = new URL('../../../../fixtures/repos/nest-discovery/', import.meta.url);
const nestMetadata = JSON.parse(readFileSync(new URL('registry.json', nestRoot), 'utf8')) as Record<
  string,
  {
    latest: string;
    peerDependencies?: Record<string, string>;
    targetPeerDependencies?: Record<string, string>;
    bin?: Record<string, string>;
  }
>;
const nestFetcher = {
  resolve: async (name: string) => nestMetadata[name]?.latest ?? '1.0.0',
  metadata: async (name: string, version: string) => {
    const m = nestMetadata[name];
    return {
      ...m,
      peerDependencies:
        version === m?.latest
          ? (m.targetPeerDependencies ?? m.peerDependencies)
          : m?.peerDependencies,
    };
  },
};
it('discovers a synthetic single-package pnpm Nest API, including tooling and peers of current packages', async () => {
  const result = await listDependencies({ cwd: fileURLToPath(nestRoot), fetcher: nestFetcher });
  expect(result.failures).toEqual([]);
  expect(result.workspaces).toEqual(['.']);
  expect(
    result.packages.filter((p) => p.classification === 'possibly-unused').map((p) => p.name),
  ).toEqual(['@types/unrelated', 'orphan']);
  const tools = [
    '@fastify/static',
    'reflect-metadata',
    '@nestjs/cli',
    '@nestjs/schematics',
    'eslint',
    'eslint-plugin-example',
    'prettier',
    'prettier-plugin-example',
    'jest',
    'ts-jest',
    'typescript',
    'webpack',
    'ts-loader',
    '@types/node',
    '@types/cookie-plugin',
    '@types/nestjs__common',
    '@example/tsconfig',
    'example-jest-preset',
    'example-lint-rules',
    'example-prettier-plugin',
    'script-runner',
    'cleanup-tool',
    'runtime-peer',
  ];
  expect(
    result.packages
      .filter((p) => p.classification === 'tooling')
      .map((p) => p.name)
      .sort(),
  ).toEqual(tools.sort());
  expect(result.packages.find((p) => p.name === 'cookie-plugin')).toMatchObject({
    classification: 'used',
    usage: { files: 1, callSites: 0, references: 1, topSymbols: [{ name: 'default', count: 1 }] },
  });
  const nest = result.packages.find((p) => p.name === '@nestjs/common');
  expect(nest).toMatchObject({ majorGap: 2, current: '10.4.0', latest: '12.0.0' });
  expect(nest?.usage.topSymbols).not.toContainEqual({ name: 'UnusedDecorator', count: 0 });
  expect(
    result.groups
      .find((g) => g.members.some((p) => p.name === '@nestjs/core'))
      ?.members.map((p) => p.name),
  ).toEqual([
    '@nestjs/common',
    '@nestjs/core',
    '@nestjs/platform-express',
    '@nestjs/platform-fastify',
    '@nestjs/swagger',
    '@fastify/static',
    'nodemailer',
    'reflect-metadata',
  ]);
  const runtimeGroup = result.groups.find((g) => g.id === 'nestjs');
  expect(runtimeGroup?.name).toBe('@nestjs/*');
  expect(result.groups.map((g) => g.id)).toContain('@nestjs/cli');
  expect(new Set(result.groups.map((g) => g.id)).size).toBe(result.groups.length);
  expect(result.packages.find((p) => p.name === '@fastify/static')).toMatchObject({
    classification: 'tooling',
    peerOf: ['@nestjs/platform-fastify'],
  });
  expect(result.packages.find((p) => p.name === 'nodemailer')).toMatchObject({
    classification: 'peer',
    peerOf: ['@nestjs/core'],
  });
  expect(result.groups.every((g) => !g.name.includes(' + '))).toBe(true);
  expect(result.packages.every((p) => p.usage.fileList === undefined)).toBe(true);
  const detailed = await listDependencies({
    cwd: fileURLToPath(nestRoot),
    fetcher: nestFetcher,
    details: true,
  });
  expect(detailed.packages.find((p) => p.name === 'cookie-plugin')?.usage.fileList).toEqual([
    'src/main.ts',
  ]);
  const selected = await listDependencies({
    cwd: fileURLToPath(nestRoot),
    fetcher: nestFetcher,
    only: ['runtime-peer'],
  });
  expect(selected.packages[0]?.classification).toBe('tooling');
});

it('uses installed bin and peer metadata without registry metadata or executing configuration', async () => {
  const cwd = fixture();
  writeFileSync(
    join(cwd, 'package.json'),
    JSON.stringify({
      scripts: { clean: 'clean-output' },
      dependencies: { tool: '1.0.0', runtime: '1.0.0', peer: '1.0.0', lookalike: '1.0.0' },
    }),
  );
  writeFileSync(join(cwd, 'index.ts'), "import 'runtime';");
  for (const [name, extra] of Object.entries({
    tool: { bin: { 'clean-output': 'cli.js' } },
    runtime: { peerDependencies: { peer: '^1' } },
  })) {
    mkdirSync(join(cwd, 'node_modules', name), { recursive: true });
    writeFileSync(
      join(cwd, 'node_modules', name, 'package.json'),
      JSON.stringify({ name, version: '1.0.0', ...extra }),
    );
  }
  writeFileSync(
    join(cwd, 'custom.config.js'),
    "throw new Error('must never execute'); // lookalike-other",
  );
  const metadata = vi.fn(async () => ({}));
  const result = await listDependencies({
    cwd,
    fetcher: { resolve: async () => '2.0.0', metadata },
  });
  expect(result.packages.find((p) => p.name === 'tool')?.classification).toBe('tooling');
  expect(result.packages.find((p) => p.name === 'peer')?.classification).toBe('tooling');
  expect(result.packages.find((p) => p.name === 'lookalike')?.classification).toBe(
    'possibly-unused',
  );
  expect(metadata).not.toHaveBeenCalledWith('tool', '1.0.0');
  expect(metadata).not.toHaveBeenCalledWith('runtime', '1.0.0');
});

it('counts value references once, excluding declarations and member names', async () => {
  const cwd = fixture();
  writeFileSync(
    join(cwd, 'index.tsx'),
    `import plugin from 'tool';
import * as api from 'other';
app.register(plugin); const options = { plugin }; const callback = api.run;
api.run(); const unrelated = { plugin: 1 }; unrelated.plugin;
`,
  );
  const scan = await scanImports(cwd, ['tool', 'other'], ['.']);
  expect(scan.get('tool')).toMatchObject({ references: 2, callSites: 0, symbols: { default: 2 } });
  expect(scan.get('other')).toMatchObject({ references: 1, callSites: 1, symbols: { run: 2 } });
});

it('does not count shadowed bindings as imported calls or references', async () => {
  const cwd = fixture();
  writeFileSync(
    join(cwd, 'index.tsx'),
    `import plugin from 'tool';
import * as components from 'other';
function unrelated(plugin: () => void) { plugin(); app.register(plugin); }
{ const plugin = () => {}; plugin(); }
app.register(plugin);
<components.Widget></components.Widget>;
`,
  );
  const scan = await scanImports(cwd, ['tool', 'other'], ['.']);
  expect(scan.get('tool')).toMatchObject({ references: 1, callSites: 0 });
  expect(scan.get('other')).toMatchObject({ references: 0, callSites: 1 });
});

it('groups lockstep scopes and required peer upgrades, without merging unrelated scoped packages', async () => {
  const cwd = fixture();
  const names = ['@suite/a', '@suite/b', '@independent/a', '@independent/b', 'view', 'view-dom'];
  writeFileSync(
    join(cwd, 'package.json'),
    JSON.stringify({
      dependencies: Object.fromEntries(
        names.map((n) => [n, n === '@independent/b' ? '3.0.0' : '1.0.0']),
      ),
    }),
  );
  writeFileSync(join(cwd, 'index.tsx'), "import '@suite/a'; import 'view-dom';");
  const result = await listDependencies({
    cwd,
    fetcher: {
      resolve: async (name) => (name === '@independent/b' ? '4.0.0' : '2.0.0'),
      metadata: async (name, version) =>
        name === 'view-dom'
          ? { peerDependencies: { view: version === '2.0.0' ? '^2.0.0' : '^1.0.0' } }
          : {},
    },
  });
  expect(result.groups.map((g) => g.name).sort()).toEqual(['@suite/*', 'view-dom']);
});

it('recognizes package entry scripts and bin paths without confusing similarly named packages', async () => {
  const cwd = fixture();
  writeFileSync(
    join(cwd, 'package.json'),
    JSON.stringify({
      scripts: { prepare: 'node ./node_modules/setup-tool/bin/run.js && ./node_modules/.bin/tidy' },
      devDependencies: { 'setup-tool': '1.0.0', cleaner: '1.0.0', setup: '1.0.0' },
    }),
  );
  const result = await listDependencies({
    cwd,
    fetcher: {
      resolve: async () => '2.0.0',
      metadata: async (name) => (name === 'cleaner' ? { bin: { tidy: 'run.js' } } : {}),
    },
  });
  expect(result.packages.filter((p) => p.classification === 'tooling').map((p) => p.name)).toEqual([
    'cleaner',
    'setup-tool',
  ]);
  expect(result.packages.find((p) => p.name === 'setup')?.classification).toBe('possibly-unused');
});
