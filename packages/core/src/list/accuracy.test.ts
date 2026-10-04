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

const manifest = (url: string) => {
  const name = decodeURIComponent(url.split('/').at(-2) ?? 'demo');
  const version = url.endsWith('/latest') ? '2.0.0' : '1.0.0';
  return Response.json({
    name,
    version,
    dist: { tarball: `https://npm.pkg.github.com/${name}.tgz` },
  });
};

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
  expect(transport).toHaveBeenCalledTimes(4); // latest + current, no separate target request
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
        reason: 'private registry needs auth (npm.pkg.github.com), skipped',
      })),
    );
    expect(transport).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result)).not.toMatch(/https:|secret|%2F|HTTP/);
  },
);

it('bounds all discovery requests together, aborts stalled bodies, and keeps fast public results', async () => {
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
  await vi.advanceTimersByTimeAsync(800);
  const report = await pending;
  expect(report.packages.map((p) => p.name)).toEqual(['public']);
  expect(report.failures).toHaveLength(2);
  expect(
    report.failures.every(
      (f) => f.reason === 'registry request timed out (npm.pkg.github.com), skipped',
    ),
  ).toBe(true);
  expect(signals.every((signal) => signal.aborted)).toBe(true);
  expect(transport).toHaveBeenCalledTimes(4);
  expect(report.timing.totalMs).toBeLessThanOrEqual(800);
});

it('does not retry or cache responses for auth, throttling and connection errors', async () => {
  const cwd = fixture('private-registry');
  const config = {
    registry: 'https://registry.example',
    scoped: {},
    tokens: { 'registry.example/': 'synthetic-secret' },
  };
  for (const respond of [
    async () => new Response('synthetic-secret', { status: 429 }),
    async () => {
      throw new Error('https://synthetic-secret@registry.example');
    },
  ]) {
    const transport = vi.fn(respond);
    const fetcher = createDiscoveryFetcher({ cwd, config, fetch: transport });
    await expect(fetcher.resolve('@example/one', 'latest')).rejects.toThrow(
      'registry request failed (registry.example), skipped',
    );
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
