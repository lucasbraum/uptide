import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { IntegrityError, PackageNotFoundError, VersionNotFoundError } from '../errors.js';
import { writeTgz } from '../test-utils/tar-writer.js';
import { createNpmFetcher, removePackageDir, tarballCachePath } from './npm-fetcher.js';
import type { RegistryConfig } from './npmrc.js';
import { withRetry } from './registry.js';

const config: RegistryConfig = {
  registry: 'https://reg.test',
  scoped: {},
  tokens: { 'reg.test/': 'tok' },
};

function stubRegistry(
  name: string,
  versions: Record<string, Buffer>,
  opts: { manifestEndpoint?: boolean } = {},
) {
  const packument = {
    'dist-tags': { latest: Object.keys(versions).at(-1) } as Record<string, string | undefined>,
    versions: Object.fromEntries(
      Object.entries(versions).map(([v, tgz]) => [
        v,
        {
          dist: {
            tarball: `https://reg.test/${name}/-/${name}-${v}.tgz`,
            integrity: `sha512-${createHash('sha512').update(tgz).digest('base64')}`,
          },
        },
      ]),
    ),
  };
  const fetchFn = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const url = String(input);
    const hit = Object.entries(versions).find(([v]) => url.endsWith(`${name}-${v}.tgz`));
    if (hit) return new Response(hit[1], { status: 200 });
    const base = `https://reg.test/${name.replace('/', '%2F')}`;
    if (url === base) return new Response(JSON.stringify(packument), { status: 200 });
    if (url.startsWith(`${base}/`) && opts.manifestEndpoint !== false) {
      const requested = decodeURIComponent(url.slice(base.length + 1));
      const version = packument['dist-tags'][requested] ?? requested;
      const manifest = packument.versions[version];
      return manifest
        ? new Response(JSON.stringify({ name, version, ...manifest }), { status: 200 })
        : new Response('{"error":"version not found"}', { status: 404 });
    }
    return new Response('nope', { status: 404 });
  });
  return { fetchFn, packument };
}

function setup(name = 'demo', opts: { manifestEndpoint?: boolean } = {}) {
  const cacheDir = mkdtempSync(join(tmpdir(), 'uptide-cache-'));
  const extractRoot = mkdtempSync(join(tmpdir(), 'uptide-extract-'));
  const tgz = writeTgz([
    {
      path: 'package/package.json',
      content: JSON.stringify({ name, version: '1.0.0', types: 'index.d.ts' }),
    },
    { path: 'package/index.d.ts', content: 'export declare const a: 1;' },
  ]);
  const { fetchFn } = stubRegistry(name, { '1.0.0': tgz }, opts);
  const fetcher = createNpmFetcher({
    cacheDir,
    extractRoot,
    config,
    fetch: fetchFn as typeof fetch,
  });
  return { cacheDir, extractRoot, tgz, fetchFn, fetcher };
}

describe('createNpmFetcher', () => {
  it('resolves, downloads, verifies and extracts', async () => {
    const { fetcher, extractRoot, fetchFn } = setup();
    const pkg = await fetcher.fetch('demo', '1.0.0');
    expect(pkg).toMatchObject({ name: 'demo', version: '1.0.0' });
    expect(pkg.dir.startsWith(extractRoot)).toBe(true);
    expect(readFileSync(join(pkg.dir, 'index.d.ts'), 'utf8')).toBe('export declare const a: 1;');
    // Auth token from config is sent as a bearer token.
    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok');
  });

  it('resolves dist-tags', async () => {
    const { fetcher } = setup();
    const pkg = await fetcher.fetch('demo', 'latest');
    expect(pkg.version).toBe('1.0.0');
  });

  it('uses the small per-version manifest, encoding scoped names', async () => {
    const { fetcher, fetchFn } = setup('@acme/demo');
    await fetcher.fetch('@acme/demo', '1.0.0');
    const urls = fetchFn.mock.calls.map(([u]) => String(u));
    expect(urls[0]).toBe('https://reg.test/@acme%2Fdemo/1.0.0');
    expect(urls).not.toContain('https://reg.test/@acme%2Fdemo');
  });

  it('falls back to the packument on registries without a manifest endpoint', async () => {
    const { fetcher, fetchFn } = setup('demo', { manifestEndpoint: false });
    const pkg = await fetcher.fetch('demo', 'latest');
    expect(pkg.version).toBe('1.0.0');
    expect(fetchFn.mock.calls.map(([u]) => String(u))).toContain('https://reg.test/demo');
  });

  it('serves the tarball from cache on the second fetch', async () => {
    const { fetcher, fetchFn, cacheDir } = setup();
    await fetcher.fetch('demo', '1.0.0');
    await fetcher.fetch('demo', '1.0.0');
    expect(existsSync(tarballCachePath(cacheDir, 'demo', '1.0.0'))).toBe(true);
    const tarballDownloads = fetchFn.mock.calls.filter(([u]) => String(u).endsWith('.tgz'));
    expect(tarballDownloads).toHaveLength(1);
  });

  it('re-downloads when the cached tarball fails integrity', async () => {
    const { fetcher, fetchFn, cacheDir } = setup();
    const path = tarballCachePath(cacheDir, 'demo', '1.0.0');
    await fetcher.fetch('demo', '1.0.0');
    writeFileSync(path, 'corrupt');
    await fetcher.fetch('demo', '1.0.0');
    const tarballDownloads = fetchFn.mock.calls.filter(([u]) => String(u).endsWith('.tgz'));
    expect(tarballDownloads).toHaveLength(2);
  });

  it('fails on a tampered download', async () => {
    const { cacheDir, extractRoot, tgz } = setup();
    const { fetchFn } = stubRegistry('demo', { '1.0.0': tgz });
    const bad = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const res = await fetchFn(input, init);
      return String(input).endsWith('.tgz') ? new Response('tampered', { status: 200 }) : res;
    });
    const fetcher = createNpmFetcher({ cacheDir, extractRoot, config, fetch: bad as typeof fetch });
    await expect(fetcher.fetch('demo', '1.0.0')).rejects.toBeInstanceOf(IntegrityError);
  });

  it('reports unknown packages and versions with typed errors', async () => {
    const { fetcher } = setup();
    await expect(fetcher.fetch('demo', '9.9.9')).rejects.toBeInstanceOf(VersionNotFoundError);
    await expect(fetcher.fetch('missing', '1.0.0')).rejects.toBeInstanceOf(PackageNotFoundError);
  });
});

describe('a registry that is rate limiting or briefly down', () => {
  const limited = (retryAfter?: string): Response =>
    new Response('slow down', {
      status: 429,
      headers: retryAfter ? { 'retry-after': retryAfter } : {},
    });

  it('retries a 429 with backoff, waiting what Retry-After asks when that is short', async () => {
    const waits: number[] = [];
    const answers = [limited('2'), limited(), new Response('ok', { status: 200 })];
    const fetchFn = vi.fn(async () => answers.shift() as Response);
    const patient = withRetry(fetchFn as typeof fetch, {
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    expect((await patient('https://reg.test/demo')).status).toBe(200);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(waits).toEqual([2000, 1500]);
  });

  it('never waits minutes, gives up after three retries, and retries no real answer', async () => {
    const waits: number[] = [];
    const sleep = async (ms: number) => {
      waits.push(ms);
    };
    const always = vi.fn(async () => limited('145'));
    expect(
      (await withRetry(always as typeof fetch, { sleep })('https://reg.test/demo')).status,
    ).toBe(429);
    expect(always).toHaveBeenCalledTimes(4);
    expect(waits).toEqual([8000, 8000, 8000]);
    const missing = vi.fn(async () => new Response('nope', { status: 404 }));
    await withRetry(missing as typeof fetch, { sleep })('https://reg.test/demo');
    expect(missing).toHaveBeenCalledTimes(1);
  });

  it('retries a dropped connection and reports the last error', async () => {
    let calls = 0;
    const flaky = withRetry(
      (async () => {
        if (++calls < 3) throw new TypeError('fetch failed');
        return new Response('ok');
      }) as typeof fetch,
      { sleep: async () => {} },
    );
    expect((await flaky('https://reg.test/demo')).status).toBe(200);
  });

  it('says rate limited and how long the registry asks to wait when nothing is cached', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'uptide-cache-'));
    const fetcher = createNpmFetcher({
      cacheDir,
      config,
      fetch: (async () => limited('145')) as typeof fetch,
      sleep: async () => {},
    });
    await expect(fetcher.resolve('demo', 'latest')).rejects.toMatchObject({
      code: 'REGISTRY_HTTP_ERROR',
      message:
        'https://reg.test/demo/latest: HTTP 429, rate limited; the registry asks to wait 145s',
    });
  });

  it('answers from the expired cache when the registry cannot', async () => {
    const { cacheDir, extractRoot, fetchFn } = setup();
    let down = false;
    const fetcher = createNpmFetcher({
      cacheDir,
      extractRoot,
      config,
      // Every cached dist-tag is already expired.
      metadataTtlMs: 0,
      fetch: (async (input: string | URL | Request, init?: RequestInit) =>
        down ? limited() : fetchFn(input, init)) as typeof fetch,
      sleep: async () => {},
    });
    expect(await fetcher.resolve('demo', 'latest')).toBe('1.0.0');
    down = true;
    expect(await fetcher.resolve('demo', 'latest')).toBe('1.0.0');
    // Never asked before, so there is nothing to fall back on: the failure is reported.
    await expect(fetcher.versions?.('demo')).rejects.toMatchObject({
      code: 'REGISTRY_HTTP_ERROR',
    });
  });
});

describe('removePackageDir', () => {
  it('removes extraction dirs and refuses anything else', async () => {
    const { fetcher, extractRoot } = setup();
    const pkg = await fetcher.fetch('demo', '1.0.0');
    await removePackageDir(pkg, extractRoot);
    expect(existsSync(pkg.dir)).toBe(false);
    await expect(removePackageDir({ ...pkg, dir: '/' }, extractRoot)).rejects.toThrow(/refusing/);
    await expect(removePackageDir({ ...pkg, dir: extractRoot }, extractRoot)).rejects.toThrow(
      /refusing/,
    );
  });
});

it('reads and caches peer metadata without tarballs, including caches from older builds', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'uptide-peers-'));
  const fetchFn = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          name: 'demo',
          version: '1.0.0',
          peerDependencies: { react: '^19' },
          dist: { tarball: 'https://reg.test/demo.tgz' },
        }),
      ),
  );
  const fetcher = createNpmFetcher({ cacheDir, config, fetch: fetchFn as typeof fetch });
  await fetcher.resolve('demo', '1.0.0');
  const oldPath = join(cacheDir, 'registry/demo/resolve-1.0.0.json');
  const oldEntry = JSON.parse(readFileSync(oldPath, 'utf8'));
  delete oldEntry.value.peerDependencies;
  writeFileSync(oldPath, JSON.stringify(oldEntry));
  expect(await fetcher.metadata?.('demo', '1.0.0')).toEqual({ peerDependencies: { react: '^19' } });
  const calls = fetchFn.mock.calls.length;
  expect(await fetcher.metadata?.('demo', '1.0.0')).toEqual({ peerDependencies: { react: '^19' } });
  expect(fetchFn.mock.calls).toHaveLength(calls);
  expect(existsSync(tarballCachePath(cacheDir, 'demo', '1.0.0'))).toBe(false);
});
