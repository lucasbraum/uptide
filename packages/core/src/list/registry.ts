import type { PackageFetcher } from '../domain/io.js';
import { errorCode } from '../errors.js';
import { loadRegistryConfig, type RegistryConfig, registryFor } from '../fetch/npmrc.js';
import { type FetchFn, type ResolvedVersion, resolveVersion } from '../fetch/registry.js';

export class DiscoveryRegistryError extends Error {
  constructor(
    readonly code: 'REGISTRY_AUTH' | 'REGISTRY_UNREACHABLE' | 'REGISTRY_HTTP_ERROR',
    reason: string,
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
      return `private registry needs auth (${host}), skipped`;
    case 'PACKAGE_NOT_FOUND':
      return `package not found (${host}), skipped`;
    case 'VERSION_NOT_FOUND':
      return `version metadata unavailable (${host}), skipped`;
    default:
      return `registry request failed (${host}), skipped`;
  }
}

/** Discovery gets one short network budget, no retries, and no credential-bearing disk cache.
 * Analysis/downloads retain their more patient retry policy. The body shares the deadline. */
export function createDiscoveryFetcher(opts: {
  cwd: string;
  config?: RegistryConfig;
  fetch?: FetchFn;
  budgetMs?: number;
}): Pick<PackageFetcher, 'resolve' | 'metadata'> {
  const config = opts.config ?? loadRegistryConfig({ cwd: opts.cwd });
  const transport = opts.fetch ?? fetch;
  const budget = opts.budgetMs ?? 800;
  let deadline: number | undefined;
  const requests = new Map<string, Promise<ResolvedVersion>>();
  const blocked = new Map<string, Error>();
  const ask = (name: string, version: string): Promise<ResolvedVersion> => {
    const failure = blocked.get(name);
    if (failure) return Promise.reject(failure);
    const key = `${name}@${version}`;
    const existing = requests.get(key);
    if (existing) return existing;
    const host = registryHost(registryFor(name, config));
    const request = (async () => {
      deadline ??= Date.now() + budget;
      const remaining = deadline - Date.now();
      const timeout = new DiscoveryRegistryError(
        'REGISTRY_UNREACHABLE',
        `registry request timed out (${host}), skipped`,
      );
      if (remaining <= 0) throw timeout;
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          resolveVersion(name, version, config, (input, init) =>
            transport(input, { ...init, signal: controller.signal }),
          ),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              reject(timeout);
              controller.abort();
            }, remaining);
          }),
        ]);
        // Resolving latest also supplies the target's peers/bins; don't fetch it again.
        requests.set(`${name}@${result.version}`, Promise.resolve(result));
        return result;
      } catch (error) {
        const safe =
          error instanceof DiscoveryRegistryError
            ? error
            : new DiscoveryRegistryError(
                errorCode(error) === 'REGISTRY_AUTH' ? 'REGISTRY_AUTH' : 'REGISTRY_HTTP_ERROR',
                registryFailure(error, host),
              );
        if (safe.code === 'REGISTRY_AUTH' || safe.code === 'REGISTRY_UNREACHABLE')
          blocked.set(name, safe);
        throw safe;
      } finally {
        clearTimeout(timer);
      }
    })();
    requests.set(key, request);
    return request;
  };
  return {
    resolve: async (name, version) => (await ask(name, version)).version,
    metadata: async (name, version) => {
      const result = await ask(name, version);
      return { peerDependencies: result.peerDependencies ?? {}, bin: result.bin };
    },
  };
}
