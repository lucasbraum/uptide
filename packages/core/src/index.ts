export {
  createTypescriptAdapter,
  type TypescriptAdapterOptions,
  typescriptAdapter,
} from './adapters/typescript/index.js';
export { createFsSurfaceCache } from './cache/fs-surface-cache.js';
export { defaultCacheDir } from './cache/paths.js';
export { requireFindUsages } from './check/capabilities.js';
export {
  type CheckOptions,
  type CheckResult,
  check,
  isFailure,
  workerHeapMb,
} from './check/check.js';
export { resolveDirection } from './check/direction.js';
export { deprecationReplacement, fixabilityOf } from './check/fixability.js';
export { match } from './check/match.js';
export { type MergedSignals, mergeSignals, symbolFromMessage } from './check/merge.js';
export { TIER_LEGEND } from './check/tier.js';
export {
  formatTruthTable,
  scoreAgainstTruth,
  type TruthCase,
  type TruthScore,
} from './check/truth.js';
export { compareVersions, majorsBehind, parseVersion } from './check/version.js';
export { classify, type UnclassifiedChange } from './diff/classify.js';
export { diffSurfaces, rawDiff } from './diff/diff.js';
export { depthOf, type Folded, foldForDisplay } from './diff/fold.js';
export { refineWithTypes } from './diff/refine.js';
export {
  type DetailedDiff,
  type DiffDirsOptions,
  type DiffPackageOptions,
  diffDirs,
  diffPackage,
  diffPackageDetailed,
  type SurfaceOptions,
  surfaceOf,
} from './diff-package.js';
export type {
  CompareTypesInput,
  CompileOptions,
  LanguageAdapter,
  PackageDir,
  ParameterComparison,
  RepoDir,
  SignatureComparison,
  TypeComparison,
  TypeRelation,
} from './domain/adapter.js';
export type { Change, ChangeKind, Severity } from './domain/change.js';
export type { PackageFetcher, SurfaceCache, SurfaceCacheKey } from './domain/io.js';
export * as symbolPath from './domain/path.js';
export type { ProgressEvent, ProgressListener } from './domain/progress.js';
export type {
  CheckReport,
  Finding,
  Fixability,
  Importer,
  PackageReport,
  PackageStatus,
  PlanGroup,
} from './domain/report.js';
export type {
  RuntimeChange,
  RuntimeChangeKind,
  RuntimeDiff,
  RuntimeSurface,
} from './domain/runtime.js';
export { isNativeProbeSkip } from './domain/runtime.js';
export type { ApiSurface, ApiSymbol, SymbolKind } from './domain/surface.js';
export { SURFACE_SCHEMA_VERSION } from './domain/surface.js';
export {
  type CompileDiagnostic,
  type CompileSignal,
  type FindUsagesResult,
  type Unanalyzed,
  USAGE_CERTAINTY,
  type Usage,
  type UsageAccess,
  type UsageVia,
  usagePaths,
} from './domain/usage.js';
export {
  AdapterCapabilityError,
  type ErrorCode,
  errorCode,
  IntegrityError,
  NoTypesError,
  PackageNotFoundError,
  RegistryAuthError,
  UptideError,
  VersionNotFoundError,
} from './errors.js';
export {
  createNpmFetcher,
  type NpmFetcherOptions,
  releasePackage,
  removePackageDir,
} from './fetch/npm-fetcher.js';
export { loadRegistryConfig, type RegistryConfig } from './fetch/npmrc.js';
export {
  cleanRuns,
  isolatedFix,
  isolatedVerify,
  removeRun,
  runsRoot,
  storedRunFile,
} from './fix/isolate.js';
export { planPackage } from './fix/plan.js';
export { openPr, type PrOptions } from './fix/pr.js';
export { updatePrBody } from './fix/pr-body.js';
export { type PublishTarget, publicationBlockers, publishTarget } from './fix/publish.js';
export {
  fixCounts,
  formatFix,
  migrationBody,
  migrationRisk,
  prBody,
  renderMigration,
  summaryCells,
} from './fix/report.js';
export { type ReverifyOptions, reverify } from './fix/reverify.js';
export { type FixOptions, fix } from './fix/run.js';
export { detectStyle } from './fix/style.js';
export type { Fixer, FixReport, FixRequest, FixResponse } from './fix/types.js';
export { sdkApiVersion, stripeConcerns, stripePack } from './packs/stripe/index.js';
export type { MigrationPack, MigrationRule } from './packs/types.js';
export { zodPack } from './packs/zod/index.js';
export { type PlanServices, upgradePlan } from './plan/gather.js';
export {
  type Effort,
  effortOf,
  type PeerConstraint,
  type PeerLookup,
  type PlannedPackage,
  planUpgrades,
  type UpgradePlan,
  type UpgradeStep,
} from './plan/plan.js';
export { diffRuntime, probeRuntime } from './runtime/runtime.js';
export { UPTIDE_COMMAND, uptideCommand, uptideVersionInfo, version } from './version.js';
