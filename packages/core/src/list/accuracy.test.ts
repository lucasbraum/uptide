import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { loadRegistryConfig } from '../fetch/npmrc.js';
import { listDependencies } from './list.js';
import { createDiscoveryFetcher } from './registry.js';

const base = fileURLToPath(new URL('../../../../fixtures/repos/list-accuracy/', import.meta.url));
const roots: string[] = [];
function fixture(name: string): string {
  const root = mkdtempSync(join(tmpdir(), 'uptide-accuracy-'));
  roots.push(root);
  cpSync(join(base, name), root, { recursive: true });
  if (existsSync(join(root, 'installed.json')))
    for (const [name, manifest] of Object.entries(
      JSON.parse(readFileSync(join(root, 'installed.json'), 'utf8')),
    )) {
      const dir = join(root, 'node_modules', name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ name, version: '1.0.0', ...(manifest as object) }),
      );
    }
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it.each([
  ['package-fields', 10],
  ['installed-bins', 5],
  ['legacy-configs', 11],
  ['web-assets', 8],
] as const)('%s: only the synthetic orphan remains possibly unused', async (name, tooling) => {
  const cwd = fixture(name);
  const report = await listDependencies({
    cwd,
    fetcher: { resolve: async () => '2.0.0', metadata: async () => ({}) },
  });
  expect(report.failures).toEqual([]);
  expect(report.packages.filter((p) => p.classification === 'tooling')).toHaveLength(tooling);
  expect(
    report.packages.filter((p) => p.classification === 'possibly-unused').map((p) => p.name),
  ).toEqual(['orphan']);
  expect(report.packages.every((p) => p.reasons.length > 0)).toBe(true);
  expect(report.packages.find((p) => p.name === 'orphan')?.reasons).toEqual([
    'no static imports, script/bin usage, configuration references, stylesheet imports or HTML assets found',
  ]);
  if (name === 'installed-bins')
    expect(report.packages.find((p) => p.name === 'webpack-cli')?.reasons).toContain(
      'used by package scripts',
    );
  if (name === 'package-fields')
    expect(report.packages.find((p) => p.name === 'cz-example')?.reasons).toContain(
      'package.json field: config.commitizen',
    );
});

const manifest = (_url: string) =>
  Response.json({
    'dist-tags': { latest: '2.0.0' },
    versions: {
      '1.0.0': { version: '1.0.0' },
      '1.1.0': { version: '1.1.0' },
      '2.0.0': { version: '2.0.0' },
    },
  });

it('uses layered registry auth without persisting credentials or rerequesting target metadata', async () => {
  const cwd = fixture('private-registry');
  const config = loadRegistryConfig({
    cwd,
    env: {
      npm_config_userconfig: join(cwd, 'user.npmrc'),
      npm_config_globalconfig: '/nonexistent',
      SYNTHETIC_REGISTRY_TOKEN: 'fixture-project-secret',
      SYNTHETIC_USER_TOKEN: 'fixture-user-secret',
    },
  });
  const transport = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    expect(new URL(String(input)).hostname).toBe('npm.pkg.github.com');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture-project-secret');
    return manifest(String(input));
  });
  vi.stubEnv('UPTIDE_CACHE_DIR', join(cwd, 'discovery-cache'));
  const before = readFileSync(join(cwd, '.npmrc'), 'utf8');
  const result = await listDependencies({
    cwd,
    fetcher: createDiscoveryFetcher({ cwd, config, fetch: transport }),
  });
  expect(result.failures).toEqual([]);
  expect(result.packages).toHaveLength(2);
  expect(transport).toHaveBeenCalledTimes(2); // one packument per package, shared by latest/current/target
  expect(JSON.stringify(result)).not.toMatch(/fixture-project-secret|fixture-user-secret|\.tgz/);
  expect(readFileSync(join(cwd, '.npmrc'), 'utf8')).toBe(before);
  expect(existsSync(join(cwd, 'discovery-cache'))).toBe(false);
});

it.each([401, 403])(
  'deduplicates HTTP %s auth failures, without URL/body/token diagnostics',
  async (status) => {
    const cwd = fixture('private-registry');
    // A root and a workspace declaring the same private package must still emit one row.
    const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
    pkg.workspaces = ['packages/*'];
    writeFileSync(join(cwd, 'package.json'), JSON.stringify(pkg));
    mkdirSync(join(cwd, 'packages/child'), { recursive: true });
    writeFileSync(
      join(cwd, 'packages/child/package.json'),
      JSON.stringify({ name: 'child', dependencies: { '@example/one': '1.1.0' } }),
    );
    const transport = vi.fn(
      async () => new Response('https://user:secret@npm.pkg.github.com?token=secret', { status }),
    );
    // Exercise the public list default too; it must use the fast discovery fetcher.
    vi.stubGlobal('fetch', transport);
    const result = await listDependencies({ cwd });
    expect(result.packages).toEqual([]);
    expect(result.failures).toEqual(
      ['@example/one', '@example/two'].map((name) => ({
        name,
        kind: 'registry',
        host: 'npm.pkg.github.com',
        status,
        summary: status === 401 ? 'auth required (401)' : 'access denied (403)',
        reason:
          status === 401
            ? 'auth required (401) for npm.pkg.github.com: check your .npmrc token. Skipped.'
            : "access denied (403) on npm.pkg.github.com, your token can't read this package. Skipped.",
      })),
    );
    expect(transport).toHaveBeenCalledTimes(2);
    expect(result.unknown?.map((p) => p.name)).toEqual(['@example/one', '@example/two']);
    expect(JSON.stringify(result)).not.toMatch(/https:|secret|%2F|HTTP/);
  },
);

it('gives each attempt 10 seconds including stalled bodies, retries once, and retains unknown packages', async () => {
  const cwd = fixture('private-registry');
  const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
  pkg.dependencies.public = '1.0.0';
  writeFileSync(join(cwd, 'package.json'), JSON.stringify(pkg));
  vi.useFakeTimers();
  const signals: AbortSignal[] = [];
  const transport = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).includes('registry.npmjs.org')) return manifest(String(input));
    signals.push(init?.signal as AbortSignal);
    return new Response(
      new ReadableStream({
        start() {
          /* response body never arrives */
        },
      }),
    );
  });
  const config = {
    registry: 'https://registry.npmjs.org',
    scoped: { '@example': 'https://npm.pkg.github.com' },
    tokens: {},
  };
  const pending = listDependencies({
    cwd,
    fetcher: createDiscoveryFetcher({ cwd, config, fetch: transport }),
  });
  await vi.advanceTimersByTimeAsync(20_000);
  const report = await pending;
  expect(report.packages.map((p) => p.name)).toEqual(['public']);
  expect(report.failures).toHaveLength(2);
  expect(
    report.failures.every((f) => f.reason === 'timed out on npm.pkg.github.com, skipped'),
  ).toBe(true);
  expect(signals.every((signal) => signal.aborted)).toBe(true);
  expect(transport).toHaveBeenCalledTimes(5); // public once; two stalled packages twice each
  expect(signals).toHaveLength(4);
  expect(report.unknown?.map((p) => p.name)).toEqual(['@example/one', '@example/two']);
  expect(report.timing.totalMs).toBe(20_000);
});

it('does not retry or cache responses for auth, throttling and connection errors', async () => {
  const cwd = fixture('private-registry');
  const config = {
    registry: 'https://registry.example',
    scoped: {},
    tokens: { 'registry.example/': 'synthetic-secret' },
  };
  for (const [respond, reason] of [
    [
      async () => new Response('synthetic-secret', { status: 429 }),
      'registry request failed (429) on registry.example, skipped',
    ],
    [
      async () => {
        throw new Error('https://synthetic-secret@registry.example');
      },
      'network request failed on registry.example, skipped',
    ],
  ] as const) {
    const transport = vi.fn(respond);
    const fetcher = createDiscoveryFetcher({ cwd, config, fetch: transport });
    await expect(fetcher.resolve('@example/one', 'latest')).rejects.toThrow(reason);
    expect(transport).toHaveBeenCalledTimes(1);
  }
});

it('ignores lookalike package names, non-import stylesheet strings, and remote HTML URLs', async () => {
  const cwd = fixture('web-assets');
  writeFileSync(
    join(cwd, 'negative.scss'),
    '@use "scss-theme" with ($label: "orphan");\n@import "orphan-extra/theme";\n',
  );
  writeFileSync(
    join(cwd, 'negative.html'),
    '<script src="https://cdn.example/node_modules/orphan/index.js"></script>',
  );
  const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
  pkg.description = 'orphan';
  writeFileSync(join(cwd, 'package.json'), JSON.stringify(pkg));
  const report = await listDependencies({
    cwd,
    fetcher: { resolve: async () => '2.0.0', metadata: async () => ({}) },
  });
  expect(report.packages.find((p) => p.name === 'orphan')?.classification).toBe('possibly-unused');
});

it('recognizes a cz-customizable configuration without executing it', async () => {
  const cwd = fixture('legacy-configs');
  renameSync(join(cwd, '.czrc'), join(cwd, '.cz-config.js'));
  writeFileSync(
    join(cwd, '.cz-config.js'),
    "throw new Error('must not execute');\nmodule.exports = { adapter: 'cz-adapter-example' };\n",
  );
  const report = await listDependencies({
    cwd,
    fetcher: { resolve: async () => '2.0.0', metadata: async () => ({}) },
  });
  expect(report.packages.find((p) => p.name === 'cz-adapter-example')).toMatchObject({
    classification: 'tooling',
    reasons: ['referenced by configuration'],
  });
});

it('recognizes installed bin aliases inside hook scripts', async () => {
  const cwd = fixture('installed-bins');
  const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
  delete pkg.scripts.commit;
  writeFileSync(join(cwd, 'package.json'), JSON.stringify(pkg));
  mkdirSync(join(cwd, '.husky'));
  writeFileSync(join(cwd, '.husky/prepare-commit-msg'), '#!/bin/sh\nnpx cz\n');
  const report = await listDependencies({
    cwd,
    fetcher: { resolve: async () => '2.0.0', metadata: async () => ({}) },
  });
  expect(report.packages.find((p) => p.name === 'commitizen')).toMatchObject({
    classification: 'tooling',
    reasons: ['referenced by configuration'],
  });
});
