import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { listDependencies } from './list.js';
import { createDiscoveryFetcher, DiscoveryRegistryError } from './registry.js';

const packument = { 'dist-tags': { latest: '2.0.0' }, versions: { '1.0.0': {}, '2.0.0': {} } };
const config = {
  registry: 'https://registry.npmjs.org',
  scoped: { '@private': 'https://npm.pkg.github.com' },
  tokens: {},
};
afterEach(() => vi.useRealTimers());

it('resolves all 80 packages against a delayed local registry with at most 16 requests in flight', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'uptide-latency-'));
  let active = 0;
  let peak = 0;
  const seen: string[] = [];
  const accepts: (string | undefined)[] = [];
  const server = createServer((req, res) => {
    seen.push(req.url ?? '');
    accepts.push(req.headers.accept);
    peak = Math.max(peak, ++active);
    setTimeout(() => {
      active--;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(packument));
    }, 220);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    cpSync(
      fileURLToPath(
        new URL('../../../../fixtures/repos/list-accuracy/large-registry/', import.meta.url),
      ),
      cwd,
      { recursive: true },
    );
    const report = await listDependencies({
      cwd,
      fetcher: createDiscoveryFetcher({
        cwd,
        config: {
          registry: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
          scoped: {},
          tokens: {},
        },
      }),
    });
    expect(report.packages).toHaveLength(80);
    expect(report.unknown).toEqual([]);
    expect(report.failures).toEqual([]);
    expect(new Set(seen).size).toBe(80);
    // Current and target reuse the abbreviated packument; each package has a newer major,
    // so its publish dates come from one full document. Still at most 16 in flight.
    expect(accepts.filter((a) => a === 'application/vnd.npm.install-v1+json')).toHaveLength(80);
    expect(accepts.filter((a) => a === 'application/json')).toHaveLength(80);
    expect(peak).toBe(16);
    expect(report.timing.totalMs).toBeGreaterThan(800); // the old global budget lost queued packages
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(cwd, { recursive: true, force: true });
  }
}, 10_000);

it.each([401, 403, 405])(
  'stops a host only after HTTP %s, leaving other hosts available',
  async (status) => {
    const transport = vi.fn(async (url: string | URL | Request) =>
      String(url).includes('npm.pkg.github.com')
        ? new Response('sensitive response', { status })
        : Response.json(packument),
    );
    const fetcher = createDiscoveryFetcher({ cwd: '.', config, fetch: transport });
    await expect(fetcher.resolve('@private/one', 'latest')).rejects.toMatchObject({ status });
    await expect(fetcher.resolve('@private/two', 'latest')).rejects.toMatchObject({ status });
    await expect(fetcher.metadata?.('@private/one', '1.0.0')).rejects.toMatchObject({ status });
    await expect(fetcher.resolve('public', 'latest')).resolves.toBe('2.0.0');
    expect(transport).toHaveBeenCalledTimes(2);
  },
);

it.each([500, 502, 503, 599])(
  'retries HTTP %s once and uses the recovered metadata',
  async (status) => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce(new Response('failure', { status }))
      .mockResolvedValueOnce(Response.json(packument));
    const fetcher = createDiscoveryFetcher({ cwd: '.', config, fetch: transport });
    await expect(fetcher.resolve('public', 'latest')).resolves.toBe('2.0.0');
    await expect(fetcher.metadata?.('public', '1.0.0')).resolves.toEqual({ peerDependencies: {} });
    expect(transport).toHaveBeenCalledTimes(2);
  },
);

it('stops after a second 5xx, reports status, and does not block its host', async () => {
  const transport = vi
    .fn()
    .mockImplementationOnce(async () => new Response('', { status: 503 }))
    .mockImplementationOnce(async () => new Response('', { status: 503 }))
    .mockResolvedValueOnce(Response.json(packument));
  const fetcher = createDiscoveryFetcher({ cwd: '.', config, fetch: transport });
  await expect(fetcher.resolve('broken', 'latest')).rejects.toThrow(
    'registry request failed (503) on registry.npmjs.org, skipped',
  );
  await expect(fetcher.resolve('working', 'latest')).resolves.toBe('2.0.0');
  expect(transport).toHaveBeenCalledTimes(3);
});

it('retries a timed-out request once with a fresh deadline', async () => {
  vi.useFakeTimers();
  let signal: AbortSignal | null | undefined;
  const transport = vi
    .fn()
    .mockImplementationOnce(async (_url, init?: RequestInit) => {
      signal = init?.signal;
      return new Promise<Response>(() => {});
    })
    .mockResolvedValueOnce(Response.json(packument));
  const fetcher = createDiscoveryFetcher({ cwd: '.', config, fetch: transport });
  const pending = fetcher.resolve('public', 'latest');
  await vi.advanceTimersByTimeAsync(10_000);
  await expect(pending).resolves.toBe('2.0.0');
  expect(signal?.aborted).toBe(true);
  expect(transport).toHaveBeenCalledTimes(2);
});

it('reports not found without retrying or blocking other packages on that host', async () => {
  const transport = vi
    .fn()
    .mockResolvedValueOnce(new Response('', { status: 404 }))
    .mockResolvedValueOnce(Response.json(packument));
  const fetcher = createDiscoveryFetcher({ cwd: '.', config, fetch: transport });
  await expect(fetcher.resolve('missing', 'latest')).rejects.toThrow(
    'not found (404) on registry.npmjs.org, skipped',
  );
  await expect(fetcher.resolve('working', 'latest')).resolves.toBe('2.0.0');
  expect(transport).toHaveBeenCalledTimes(2);
});

it('keeps a known outdated package when only peer metadata fails', async () => {
  const report = await listDependencies({
    cwd: fileURLToPath(
      new URL('../../../../fixtures/repos/list-accuracy/private-registry/', import.meta.url),
    ),
    fetcher: {
      resolve: async () => '2.0.0',
      metadata: async () => {
        throw new DiscoveryRegistryError(
          'REGISTRY_UNREACHABLE',
          'timed out on registry.example, skipped',
          'registry.example',
          'timed out',
        );
      },
    },
  });
  expect(report.packages).toHaveLength(2);
  expect(report.unknown).toEqual([]);
  expect(report.failures).toHaveLength(2);
});

it('recognizes a transport timeout as timed out and retries it once', async () => {
  const error = new TypeError('fetch failed', { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } });
  const transport = vi
    .fn()
    .mockRejectedValueOnce(error)
    .mockResolvedValueOnce(Response.json(packument));
  const fetcher = createDiscoveryFetcher({ cwd: '.', config, fetch: transport });
  await expect(fetcher.resolve('public', 'latest')).resolves.toBe('2.0.0');
  expect(transport).toHaveBeenCalledTimes(2);
});
