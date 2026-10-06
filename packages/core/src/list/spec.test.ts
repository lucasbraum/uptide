import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { listDependencies } from './list.js';
import { createDiscoveryFetcher } from './registry.js';
import { dependencySource } from './spec.js';

const fixture = fileURLToPath(
  new URL('../../../../fixtures/repos/list-accuracy/dependency-sources/', import.meta.url),
);
const roots: string[] = [];
const root = (): string => {
  const cwd = mkdtempSync(join(tmpdir(), 'uptide-sources-'));
  roots.push(cwd);
  cpSync(fixture, cwd, { recursive: true });
  return cwd;
};
afterEach(() => {
  for (const cwd of roots.splice(0)) rmSync(cwd, { recursive: true, force: true });
});
const skipped = {
  'github-protocol': 'github',
  'github-shorthand': 'github',
  'git-https': 'git',
  'git-ssh': 'git',
  'git-protocol': 'git',
  'git-scp': 'git',
  'local-file': 'file',
  'local-link': 'link',
  'local-workspace': 'workspace',
  'http-tarball': 'http',
  'https-tarball': 'https',
  'alias-github': 'github',
  'alias-git-https': 'git',
  'alias-git-ssh': 'git',
  'alias-git-protocol': 'git',
  'alias-file': 'file',
  'alias-link': 'link',
  'alias-workspace': 'workspace',
  'alias-http': 'http',
  'alias-https': 'https',
  'alias-direct-github': 'github',
  'alias-direct-file': 'file',
};
it.each(Object.entries(skipped))(
  'skips fixture %s as %s, including locked non-registry dependencies',
  async (name, source) => {
    const resolve = vi.fn(async () => {
      throw new Error('must not request non-registry sources');
    });
    const report = await listDependencies({ cwd: root(), only: [name], fetcher: { resolve } });
    expect(resolve).not.toHaveBeenCalled();
    expect(report.skipped).toEqual([
      { name, source, reason: `not checked: non-registry source (${source})`, workspaces: ['.'] },
    ]);
    expect(report.failures).toEqual([]);
    expect(report.unknown).toEqual([]);
    expect(report.packages).toEqual([]);
    expect(JSON.stringify(report)).not.toMatch(
      /synthetic-private|example\.invalid|example\/synthetic/,
    );
  },
);
it('checks the real names of aliases, retains local import usage and ignores registry tarball URLs in locks', async () => {
  const resolve = vi.fn(async (_name: string, _version: string) => '2.0.0');
  const metadata = vi.fn(async (_name: string, _version: string) => ({ bin: 'bin/run.js' }));
  const report = await listDependencies({ cwd: root(), fetcher: { resolve, metadata } });
  expect(report.failures).toEqual([]);
  expect(report.unknown).toEqual([]);
  expect(report.skipped).toHaveLength(22);
  expect(resolve.mock.calls.map((args) => args[0]).sort()).toEqual([
    '@example/real-scoped',
    'ordinary',
    'real-runtime',
    'typescript',
  ]);
  expect(metadata.mock.calls.map((args) => args[0])).not.toContain('registry-alias');
  expect(report.packages).toHaveLength(4);
  expect(report.packages.find((p) => p.name === 'registry-alias')).toMatchObject({
    registryName: 'real-runtime',
    current: '1.0.0',
    latest: '2.0.0',
    usage: { files: 1, callSites: 1 },
  });
  expect(report.packages.find((p) => p.name === 'scoped-alias')).toMatchObject({
    registryName: '@example/real-scoped',
    current: '1.0.0',
  });
  expect(report.packages.find((p) => p.name === 'tool-alias')).toMatchObject({
    registryName: 'typescript',
    classification: 'tooling',
  });
  expect(report.packages.find((p) => p.name === 'ordinary')).not.toHaveProperty('registryName');
});
it('uses the real scoped alias target for registry selection and authentication', async () => {
  const cwd = root();
  writeFileSync(
    join(cwd, 'package.json'),
    JSON.stringify({
      name: 'alias-app',
      dependencies: { alias: 'npm:@example/real-scoped@1.0.0' },
    }),
  );
  const transport = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    expect(String(url)).toBe('https://private.example/@example%2Freal-scoped');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer synthetic-token');
    return Response.json({
      'dist-tags': { latest: '2.0.0' },
      versions: { '1.0.0': {}, '2.0.0': {} },
    });
  });
  const report = await listDependencies({
    cwd,
    fetcher: createDiscoveryFetcher({
      cwd,
      fetch: transport,
      config: {
        registry: 'https://public.example',
        scoped: { '@example': 'https://private.example' },
        tokens: { 'private.example/': 'synthetic-token' },
      },
    }),
  });
  // The packument, then the full document for publish dates: both from the real target.
  expect(transport).toHaveBeenCalledTimes(2);
  expect(report.failures).toEqual([]);
  expect(report.packages[0]).toMatchObject({ name: 'alias', registryName: '@example/real-scoped' });
  expect(JSON.stringify(report)).not.toContain('synthetic-token');
});
it('keeps the same local alias with different workspace targets separate', async () => {
  const cwd = root();
  writeFileSync(
    join(cwd, 'package.json'),
    JSON.stringify({
      name: 'root',
      workspaces: ['packages/*'],
      dependencies: { alias: 'npm:first-real@1.0.0', local: 'workspace:*' },
    }),
  );
  mkdirSync(join(cwd, 'packages/child'), { recursive: true });
  writeFileSync(
    join(cwd, 'packages/child/package.json'),
    JSON.stringify({
      name: 'local',
      dependencies: { alias: 'npm:second-real@1.0.0', remote: 'github:example/synthetic' },
    }),
  );
  const report = await listDependencies({
    cwd,
    fetcher: { resolve: async (name) => (name === 'first-real' ? '2.0.0' : '3.0.0') },
  });
  expect(report.failures).toEqual([]);
  expect(report.packages.map((p) => [p.name, p.registryName, p.latest, p.workspaces])).toEqual([
    ['alias', 'first-real', '2.0.0', ['.']],
    ['alias', 'second-real', '3.0.0', ['packages/child']],
  ]);
  expect(report.skipped?.map((p) => [p.name, p.source])).toEqual([
    ['local', 'workspace'],
    ['remote', 'github'],
  ]);
  const failed = await listDependencies({
    cwd,
    fetcher: {
      resolve: async () => {
        throw new Error('offline');
      },
    },
  });
  expect(failed.failures).toHaveLength(1);
  expect(failed.unknown).toEqual([
    {
      name: 'alias',
      currentVersions: ['1.0.0'],
      workspaces: ['.', 'packages/child'],
      reason: 'offline',
    },
  ]);
});
it('normalizes pnpm alias versions before comparing with the real target', async () => {
  const cwd = root();
  writeFileSync(
    join(cwd, 'package.json'),
    JSON.stringify({ name: 'app', dependencies: { alias: 'npm:@example/actual@^1.0.0' } }),
  );
  writeFileSync(
    join(cwd, 'pnpm-lock.yaml'),
    "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      alias:\n        specifier: npm:@example/actual@^1.0.0\n        version: '@example/actual@1.4.0(peer@1.0.0)'\n",
  );
  const report = await listDependencies({ cwd, fetcher: { resolve: async () => '2.0.0' } });
  expect(report.failures).toEqual([]);
  expect(report.packages[0]).toMatchObject({
    name: 'alias',
    registryName: '@example/actual',
    current: '1.4.0',
    latest: '2.0.0',
  });
});
it.each([null, 42, {}, 'npm:', 'npm:@broken'])(
  'treats malformed declarations as real failures (%j)',
  async (spec) => {
    const cwd = root();
    const manifest = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
    manifest.dependencies = { broken: spec, valid: 'file:../synthetic-private-path' };
    writeFileSync(join(cwd, 'package.json'), JSON.stringify(manifest));
    const resolve = vi.fn(async (_name: string, _version: string) => '2.0.0');
    const report = await listDependencies({ cwd, fetcher: { resolve } });
    expect(report.failures).toEqual([
      {
        name: 'broken',
        workspace: '.',
        reason: 'malformed dependency declaration in package.json',
      },
    ]);
    expect(report.skipped).toHaveLength(1);
    expect(resolve).not.toHaveBeenCalled();
  },
);
it.each([
  'npm:github:example/synthetic',
  'npm:alias@github:example/synthetic',
  'npm:alias@npm:github:example/synthetic',
])('unwraps non-registry alias %s', (spec) => {
  expect(dependencySource('alias', spec)).toEqual({ kind: 'non-registry', source: 'github' });
});

it('checks an explicit registry alias even when its name matches a local workspace', async () => {
  const cwd = root();
  writeFileSync(
    join(cwd, 'package.json'),
    JSON.stringify({
      name: 'root',
      workspaces: ['packages/*'],
      dependencies: { local: 'npm:local@1.0.0' },
    }),
  );
  mkdirSync(join(cwd, 'packages/child'), { recursive: true });
  writeFileSync(join(cwd, 'packages/child/package.json'), JSON.stringify({ name: 'local' }));
  const resolve = vi.fn(async (_name: string, _version: string) => '2.0.0');
  const report = await listDependencies({ cwd, fetcher: { resolve } });
  expect(resolve).toHaveBeenCalledWith('local', 'latest');
  expect(report.skipped).toEqual([]);
  expect(report.failures).toEqual([]);
  expect(report.packages[0]).toMatchObject({ name: 'local', current: '1.0.0', latest: '2.0.0' });
});

it('resolves default and named pnpm catalogs before classifying dependency sources', async () => {
  const cwd = root();
  writeFileSync(
    join(cwd, 'package.json'),
    JSON.stringify({
      name: 'catalog-app',
      dependencies: {
        ordinary: 'catalog:',
        alias: 'catalog:tools',
        local: 'catalog:',
        missing: 'catalog:missing',
      },
    }),
  );
  writeFileSync(
    join(cwd, 'pnpm-workspace.yaml'),
    `catalog:
  ordinary: 1.0.0
  local: github:example/synthetic
catalogs:
  tools:
    alias: npm:real-runtime@1.0.0
`,
  );
  const resolve = vi.fn(async () => '2.0.0');
  const report = await listDependencies({ cwd, fetcher: { resolve, metadata: async () => ({}) } });
  expect(report.packages.map((p) => p.name).sort()).toEqual(['alias', 'ordinary']);
  expect(report.packages.find((p) => p.name === 'alias')?.registryName).toBe('real-runtime');
  expect(report.skipped).toEqual([expect.objectContaining({ name: 'local', source: 'github' })]);
  expect(report.failures).toEqual([
    expect.objectContaining({
      name: 'missing',
      reason: 'malformed dependency declaration in package.json',
    }),
  ]);
  expect(resolve).toHaveBeenCalledTimes(2);
});
