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
import type { Advisory } from './priorities.js';

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
  deprecated?: string;
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

/** What the priority signals read from a registry, beyond versions and peers. */
export interface RegistrySignals {
  /** The deprecation message of one version, from the packument already fetched. */
  deprecation(name: string, version: string): Promise<string | undefined>;
  /** Every published version, from the packument already fetched. */
  versions(name: string): Promise<string[]>;
  /** The registry's `time` map: one full-document request, made only when asked. */
  published(name: string): Promise<Record<string, string>>;
  /**
   * Known advisories in one bulk request, for packages served by the public npm registry;
   * names served by another registry are left out of the request and of `checked`.
   */
  advisories(
    query: Map<string, string[]>,
  ): Promise<{ checked: string[]; advisories: Record<string, Advisory[]> }>;
}

const NPM_REGISTRY = 'registry.npmjs.org';

/** One abbreviated packument per package, kept in memory only. Each HTTP attempt gets
 * its own deadline (including the body); only timeout/5xx gets one retry. List's pool
 * bounds concurrency. A host is blocked only after it actually answers 401/403/405. */
export function createDiscoveryFetcher(opts: {
  cwd: string;
  config?: RegistryConfig;
  fetch?: FetchFn;
  timeoutMs?: number;
  /** Deadline for the optional signal requests (advisories, publish dates); they never retry. */
  signalTimeoutMs?: number;
}): Pick<PackageFetcher, 'resolve' | 'metadata'> & RegistrySignals {
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
  const signalTimeoutMs = opts.signalTimeoutMs ?? 5_000;
  /** One request under a deadline, body included; any failure is the caller's "not checked". */
  const once = async <T>(url: string, init: RequestInit): Promise<T> => {
    const signal = AbortSignal.timeout(signalTimeoutMs);
    const response = await transport(url, { ...init, signal });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new Error(`${registryHost(url)} answered ${response.status}`);
    }
    return (await response.json()) as T;
  };
  const times = new Map<string, Promise<Record<string, string>>>();
  return {
    resolve: async (name, version) => (await manifest(name, version)).version,
    deprecation: async (name, version) => (await ask(name)).versions?.[version]?.deprecated,
    versions: async (name) => Object.keys((await ask(name)).versions ?? {}),
    published: (name) => {
      let request = times.get(name);
      if (!request) {
        const url = packumentUrl(name, registryFor(name, config).replace(/\/$/, ''));
        request = once<{ time?: Record<string, string> }>(url, {
          headers: { accept: 'application/json', ...authHeaders(url, config) },
        }).then((doc) => doc.time ?? {});
        times.set(name, request);
      }
      return request;
    },
    advisories: async (query) => {
      const body = Object.fromEntries(
        [...query].filter(([name]) => registryHost(registryFor(name, config)) === NPM_REGISTRY),
      );
      const checked = Object.keys(body);
      if (!checked.length) return { checked, advisories: {} };
      const advisories = await once<Record<string, Advisory[]>>(
        `https://${NPM_REGISTRY}/-/npm/v1/security/advisories/bulk`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(body),
        },
      );
      return { checked, advisories };
    },
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
