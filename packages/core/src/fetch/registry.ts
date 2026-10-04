import { compareVersions, parseVersion } from '../check/version.js';
import {
  PackageNotFoundError,
  RegistryAuthError,
  UptideError,
  VersionNotFoundError,
} from '../errors.js';
import { type RegistryConfig, registryFor, tokenFor } from './npmrc.js';

export type FetchFn = typeof fetch;

export interface ResolvedVersion {
  /** Evidence from an unauthenticated public npm metadata response; absent in older caches. */
  publicRegistry?: boolean;
  name: string;
  version: string;
  tarball: string;
  peerDependencies?: Record<string, string>;
  bin?: string | Record<string, string>;
  /** SRI string (`sha512-…`) when the registry provides one. */
  integrity?: string;
  /** Hex sha1, older registries only. */
  shasum?: string;
}

interface Manifest {
  peerDependencies?: Record<string, string>;
  bin?: string | Record<string, string>;
  version?: string;
  dist?: { tarball?: string; integrity?: string; shasum?: string };
}

interface AbbreviatedPackument {
  'dist-tags'?: Record<string, string>;
  versions?: Record<string, Manifest>;
}

export function packumentUrl(name: string, registry: string): string {
  // Scoped names keep their `@` but the `/` must be encoded.
  return `${registry}/${name.replace('/', '%2F')}`;
}

export function manifestUrl(name: string, version: string, registry: string): string {
  return `${packumentUrl(name, registry)}/${encodeURIComponent(version)}`;
}

function authHeaders(url: string, config: RegistryConfig): Record<string, string> {
  const token = tokenFor(url, config);
  return token ? { authorization: `Bearer ${token}` } : {};
}

export interface RetryOptions {
  /** Attempts after the first one. Default 3. */
  retries?: number;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
}

/** Rate limited or briefly down: worth asking again. A 404 or a 401 is an answer. */
const TRANSIENT = new Set([429, 500, 502, 503, 504]);
const BACKOFF_MS = [500, 1500, 4000];
/** A registry may ask for minutes; a command waits seconds, then says what happened. */
const MAX_WAIT_MS = 8000;

function retryAfterMs(res: Response): number | undefined {
  const seconds = Number(res.headers.get('retry-after'));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

/**
 * The same fetch, patient: a rate limit (429), a gateway error or a dropped connection is
 * retried with backoff, waiting what `Retry-After` asks when that is a few seconds. After
 * the last attempt the caller gets the registry's own answer, or the connection error.
 */
export function withRetry(fetchFn: FetchFn, options: RetryOptions = {}): FetchFn {
  const retries = options.retries ?? BACKOFF_MS.length;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  return async (input, init) => {
    for (let attempt = 0; ; attempt++) {
      const last = attempt >= retries;
      const backoff = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] as number;
      try {
        const res = await fetchFn(input, init);
        if (!TRANSIENT.has(res.status) || last) return res;
        await sleep(Math.min(retryAfterMs(res) ?? backoff, MAX_WAIT_MS));
      } catch (err) {
        if (last) throw err;
        await sleep(backoff);
      }
    }
  };
}

/** `HTTP 429, rate limited; the registry asks to wait 145s`: what a person needs to know. */
function httpFailure(res: Response): string {
  const wait = retryAfterMs(res);
  const what = res.status === 429 ? ', rate limited' : '';
  return `HTTP ${res.status}${what}${wait ? `; the registry asks to wait ${Math.ceil(wait / 1000)}s` : ''}`;
}

async function request(fetchFn: FetchFn, url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetchFn(url, init);
  } catch (cause) {
    throw new UptideError('REGISTRY_UNREACHABLE', `cannot reach registry: ${url}`, { cause });
  }
}
async function getJson<T>(
  url: string,
  config: RegistryConfig,
  fetchFn: FetchFn,
): Promise<T | undefined> {
  const res = await request(fetchFn, url, {
    headers: {
      // The abbreviated document is a fraction of the size and has everything we need.
      accept: 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8',
      ...authHeaders(url, config),
    },
  });
  if (res.status === 404) return undefined;
  if (res.status === 401 || res.status === 403) {
    throw new RegistryAuthError(
      url.split('/').slice(3).join('/'),
      url.split('/').slice(0, 3).join('/'),
      res.status,
    );
  }
  if (!res.ok) throw new UptideError('REGISTRY_HTTP_ERROR', `${url}: ${httpFailure(res)}`);
  return (await res.json()) as T;
}

function toResolved(name: string, manifest: Manifest | undefined): ResolvedVersion | undefined {
  if (!manifest?.version || !manifest.dist?.tarball) return undefined;
  const resolved: ResolvedVersion = {
    name,
    version: manifest.version,
    tarball: manifest.dist.tarball,
    peerDependencies: manifest.peerDependencies ?? {},
  };
  if (manifest.bin) resolved.bin = manifest.bin;
  if (manifest.dist.integrity) resolved.integrity = manifest.dist.integrity;
  if (manifest.dist.shasum) resolved.shasum = manifest.dist.shasum;
  return resolved;
}

/** Accepts an exact version or a dist-tag. Ranges are deliberately unsupported: a diff needs two exact points. */
export function resolveFromPackument(
  name: string,
  requested: string,
  packument: AbbreviatedPackument,
): ResolvedVersion {
  const versions = packument.versions ?? {};
  const version = packument['dist-tags']?.[requested] ?? requested;
  const resolved = toResolved(name, { ...versions[version], version });
  if (!resolved) throw new VersionNotFoundError(name, requested, Object.keys(versions));
  return resolved;
}

/**
 * Resolves `name@requested` to a tarball. The per-version manifest endpoint is tried first
 * because a full packument for a package with thousands of releases is tens of megabytes
 * (next's is 25MB) while the manifest is a few kilobytes. The packument is the fallback for
 * registries without that endpoint and for the error path, where listing what does exist
 * is worth the download.
 */
export async function resolveVersion(
  name: string,
  requested: string,
  config: RegistryConfig,
  fetchFn: FetchFn,
): Promise<ResolvedVersion> {
  const registry = registryFor(name, config);
  const manifest = await getJson<Manifest>(manifestUrl(name, requested, registry), config, fetchFn);
  const fast = toResolved(name, manifest);
  if (fast) return fast;
  const packument = await getJson<AbbreviatedPackument>(
    packumentUrl(name, registry),
    config,
    fetchFn,
  );
  if (!packument) throw new PackageNotFoundError(name, registry);
  return resolveFromPackument(name, requested, packument);
}

export async function downloadTarball(
  resolved: ResolvedVersion,
  config: RegistryConfig,
  fetchFn: FetchFn,
): Promise<Buffer> {
  const res = await request(fetchFn, resolved.tarball, {
    headers: authHeaders(resolved.tarball, config),
  });
  if (!res.ok)
    throw new UptideError('REGISTRY_HTTP_ERROR', `${resolved.tarball}: ${httpFailure(res)}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Every published version of `name`, oldest first, from the abbreviated packument. */
export async function listVersions(
  name: string,
  config: RegistryConfig,
  fetchFn: FetchFn,
): Promise<string[]> {
  const registry = registryFor(name, config);
  const packument = await getJson<AbbreviatedPackument>(
    packumentUrl(name, registry),
    config,
    fetchFn,
  );
  if (!packument) throw new PackageNotFoundError(name, registry);
  return Object.keys(packument.versions ?? {})
    .filter((v) => parseVersion(v) !== undefined)
    .sort(compareVersions);
}
