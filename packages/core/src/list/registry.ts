import { compareVersions, parseVersion } from '../check/version.js';
import type { PackageFetcher } from '../domain/io.js';
import { errorCode } from '../errors.js';
import {
  authHeaders,
  loadRegistryConfig,
  type RegistryConfig,
  registryFor,
} from '../fetch/npmrc.js';
import { type FetchFn, packumentUrl } from '../fetch/registry.js';

export class DiscoveryRegistryError extends Error {
  constructor(
    readonly code: 'REGISTRY_AUTH' | 'REGISTRY_UNREACHABLE' | 'REGISTRY_HTTP_ERROR',
    reason: string,
    readonly host: string,
    readonly summary: string,
    readonly status?: number,
  ) {
    super(reason);
  }
}
export function registryHost(registry: string): string {
  try {
    return new URL(registry).hostname;
  } catch {
    return 'configured registry';
  }
}
export function registryFailure(error: unknown, host: string): string {
  if (error instanceof DiscoveryRegistryError) return error.message;
  switch (errorCode(error)) {
    case 'REGISTRY_AUTH':
      return `auth required for ${host}: check your .npmrc token. Skipped.`;
    case 'PACKAGE_NOT_FOUND':
      return `not found on ${host}, skipped`;
    case 'VERSION_NOT_FOUND':
      return `version metadata unavailable on ${host}, skipped`;
    default:
      return `registry request failed on ${host}, skipped`;
  }
}

interface Manifest {
  version?: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  bin?: string | Record<string, string>;
}
interface Packument {
  'dist-tags'?: Record<string, string>;
  versions?: Record<string, Manifest>;
}
function httpError(host: string, status: number): DiscoveryRegistryError {
  const summary =
    status === 401
      ? 'auth required (401)'
      : status === 403
        ? 'access denied (403)'
        : status === 404
          ? 'not found (404)'
          : status === 405
            ? 'method not allowed (405)'
            : `registry request failed (${status})`;
  const reason =
    status === 401
      ? `${summary} for ${host}: check your .npmrc token. Skipped.`
      : status === 403
        ? `${summary} on ${host}, your token can't read this package. Skipped.`
        : `${summary} on ${host}, skipped`;
  return new DiscoveryRegistryError(
    [401, 403, 405].includes(status) ? 'REGISTRY_AUTH' : 'REGISTRY_HTTP_ERROR',
    reason,
    host,
    summary,
    status,
  );
}

function isTimeout(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  if ('name' in error && error.name === 'TimeoutError') return true;
  if (
    'code' in error &&
    [
      'ETIMEDOUT',
      'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_HEADERS_TIMEOUT',
      'UND_ERR_BODY_TIMEOUT',
    ].includes(String(error.code))
  )
    return true;
  return 'cause' in error && error.cause !== error && isTimeout(error.cause);
}

/** One abbreviated packument per package, kept in memory only. Each HTTP attempt gets
 * its own deadline (including the body); only timeout/5xx gets one retry. List's pool
 * bounds concurrency. A host is blocked only after it actually answers 401/403/405. */
export function createDiscoveryFetcher(opts: {
  cwd: string;
  config?: RegistryConfig;
  fetch?: FetchFn;
  timeoutMs?: number;
}): Pick<PackageFetcher, 'resolve' | 'metadata'> {
  const config = opts.config ?? loadRegistryConfig({ cwd: opts.cwd });
  const transport = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const requests = new Map<string, Promise<Packument>>();
  const blockedHosts = new Map<string, DiscoveryRegistryError>();
  const ask = (name: string): Promise<Packument> => {
    const existing = requests.get(name);
    if (existing) return existing;
    const registry = registryFor(name, config);
    const host = registryHost(registry);
    const request = (async () => {
      for (let attempt = 0; ; attempt++) {
        const blocked = blockedHosts.get(host);
        if (blocked) throw blocked;
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new DiscoveryRegistryError(
          'REGISTRY_UNREACHABLE',
          `timed out on ${host}, skipped`,
          host,
          'timed out',
        );
        try {
          return await Promise.race([
            (async () => {
              const url = packumentUrl(name, registry.replace(/\/$/, ''));
              const response = await transport(url, {
                headers: {
                  accept: 'application/vnd.npm.install-v1+json',
                  ...authHeaders(url, config),
                },
                signal: controller.signal,
              });
              if (!response.ok) {
                const error = httpError(host, response.status);
                // Record immediately, before another queued package can start a request.
                if (error.code === 'REGISTRY_AUTH') blockedHosts.set(host, error);
                void response.body?.cancel().catch(() => {});
                throw error;
              }
              return (await response.json()) as Packument;
            })(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                reject(timeout);
                controller.abort();
              }, timeoutMs);
            }),
          ]);
        } catch (error) {
          const safe =
            error instanceof DiscoveryRegistryError
              ? error
              : isTimeout(error)
                ? timeout
                : new DiscoveryRegistryError(
                    'REGISTRY_UNREACHABLE',
                    `network request failed on ${host}, skipped`,
                    host,
                    'network request failed',
                  );
          if (
            attempt === 0 &&
            (safe === timeout ||
              (safe.status !== undefined && safe.status >= 500 && safe.status <= 599))
          )
            continue;
          throw safe;
        } finally {
          clearTimeout(timer);
        }
      }
    })();
    requests.set(name, request);
    return request;
  };
  const manifest = async (name: string, spec: string): Promise<Manifest & { version: string }> => {
    const data = await ask(name);
    const version =
      data['dist-tags']?.[spec] ??
      (spec === 'latest'
        ? Object.keys(data.versions ?? {})
            .filter((v) => parseVersion(v) && !parseVersion(v)?.pre)
            .sort(compareVersions)
            .at(-1)
        : spec);
    const entry = version && data.versions?.[version];
    if (!entry || !version) {
      const host = registryHost(registryFor(name, config));
      throw new DiscoveryRegistryError(
        'REGISTRY_HTTP_ERROR',
        `version metadata unavailable on ${host}, skipped`,
        host,
        'version metadata unavailable',
      );
    }
    return { ...entry, version };
  };
  return {
    resolve: async (name, version) => (await manifest(name, version)).version,
    metadata: async (name, version) => {
      const result = await manifest(name, version);
      return {
        ...(result.dependencies ? { dependencies: result.dependencies } : {}),
        peerDependencies: result.peerDependencies ?? {},
        bin: result.bin,
      };
    },
  };
}
