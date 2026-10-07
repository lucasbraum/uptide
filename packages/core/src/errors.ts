/** The package ships no type declarations, so there is nothing to analyze. The CLI reports this instead of guessing. */
export class NoTypesError extends Error {
  readonly code = 'NO_TYPES' as const;
  override readonly name = 'NoTypesError';
  constructor(
    readonly packageName: string,
    readonly version: string,
  ) {
    super(`${packageName}@${version}: no type declarations, cannot analyze`);
  }
}

export class PackageNotFoundError extends Error {
  readonly code = 'PACKAGE_NOT_FOUND' as const;
  override readonly name = 'PackageNotFoundError';
  constructor(
    readonly packageName: string,
    readonly registry: string,
  ) {
    super(`${packageName}: not found on ${registry}`);
  }
}

export class RegistryAuthError extends Error {
  readonly code = 'REGISTRY_AUTH' as const;
  override readonly name = 'RegistryAuthError';
  constructor(
    readonly packageName: string,
    readonly registry: string,
    readonly status: number,
  ) {
    super(`${packageName}: ${registry} answered HTTP ${status} (registry auth)`);
  }
}

export class VersionNotFoundError extends Error {
  readonly code = 'VERSION_NOT_FOUND' as const;
  override readonly name = 'VersionNotFoundError';
  constructor(
    readonly packageName: string,
    readonly version: string,
    readonly available: string[],
  ) {
    super(
      `${packageName}@${version}: version not published (${available.length} versions available)`,
    );
  }
}

export class IntegrityError extends Error {
  override readonly name = 'IntegrityError';
  constructor(
    readonly packageName: string,
    readonly version: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      `${packageName}@${version}: tarball integrity mismatch (expected ${expected}, got ${actual})`,
    );
  }
}

/** `check` needs an adapter that finds usages; an empty usage list would render as "no impact", which is a lie. */
export class AdapterCapabilityError extends Error {
  override readonly name = 'AdapterCapabilityError';
  constructor(
    readonly adapter: string,
    readonly capability: 'findUsages' | 'compareTypes',
  ) {
    super(`adapter "${adapter}" does not implement ${capability}; cannot check usages`);
  }
}

export type ErrorCode =
  | 'REGISTRY_UNREACHABLE'
  | 'REGISTRY_HTTP_ERROR'
  | 'REGISTRY_AUTH'
  | 'PACKAGE_NOT_FOUND'
  | 'VERSION_NOT_FOUND'
  | 'NO_TYPES'
  | 'NO_LOCKFILE'
  | 'PACKAGE_NOT_INSTALLED'
  | 'UNSUPPORTED_PACKAGE_MANAGER'
  | 'DIRTY_WORKING_TREE'
  | 'DIRTY_UPTIDE_TREE'
  | 'PUBLICATION_REFUSED'
  | 'SERVICES_NOT_CONFIRMED'
  | 'NOT_REPOSITORY_ROOT'
  | 'INCOMPLETE_CHECK'
  | 'NO_PROJECT'
  | 'TYPESCRIPT_UNAVAILABLE'
  | 'INSTALL_FAILED'
  | 'INCONSISTENT_UPGRADE'
  | 'PACKAGE_MANAGER_UNAVAILABLE'
  | 'PACKAGE_MANAGER_VERSION'
  | 'LOCKFILE_OUT_OF_SCOPE'
  | 'UNSUPPORTED_LOCKFILE'
  | 'UNSUPPORTED_VERSION_RANGE'
  | 'ANALYSIS_FAILED'
  | 'TIME_BUDGET'
  | 'MEMORY_BUDGET'
  | 'ERR_WORKER_OUT_OF_MEMORY'
  | 'ANALYSIS_STACK_OVERFLOW'
  | 'NO_FIXER'
  | 'RUN_STALE'
  | 'INVALID_WORKSPACE'
  | 'GROUND_TRUTH_NOT_CACHED'
  | 'GROUND_TRUTH_FETCH'
  | 'GROUND_TRUTH_INSTALL'
  | 'INVALID_GROUND_TRUTH'
  | 'NOT_UPTIDE_CHECKOUT'
  | 'PACK_EXISTS';
/** Stable across rendering and worker serialization. Human wording is not an API. */
export class UptideError extends Error {
  override readonly name = 'UptideError';
  constructor(
    readonly code: ErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
export function errorCode(error: unknown): ErrorCode {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string')
    return error.code as ErrorCode;
  return 'ANALYSIS_FAILED';
}
