import type { PackageFetcher } from './io.js';
import type { ApiSurface } from './surface.js';
import type { CompileSignal, FindUsagesResult } from './usage.js';

/** An extracted npm package on disk. `dir` contains its package.json. Nothing in it is ever executed. */
export interface PackageDir {
  name: string;
  version: string;
  dir: string;
  /** Directories of type packages to load alongside (the consumer's `@types/node`), so `events` and `http` resolve. */
  types?: string[];
}

/** A consumer repository on disk. Read only: nothing in it is ever executed. */
export interface RepoDir {
  dir: string;
  /** The repository root when `dir` is a workspace inside it: what another workspace's source is still part of. */
  root?: string;
  /** Absolute source roots for a named check; imports are followed by the compiler. */
  rootFiles?: string[];
  /**
   * Absolute directories inside `dir` whose files belong to another workspace package that
   * answers for this dependency itself. Their usages and errors are that package's, not this one's.
   */
  exclude?: string[];
}

/**
 * How the type behind a path in version B relates to the one in version A, by the
 * language's own assignability rules. `widened`: A is assignable to B but not back (B is
 * a supertype). `narrowed`: B is assignable to A but not back. `any`/`unknown` on one side
 * only counts as widened/narrowed even though assignability would say equivalent.
 */
export type TypeRelation = 'equivalent' | 'widened' | 'narrowed' | 'incompatible';

export interface ParameterComparison {
  name: string;
  relation: TypeRelation | 'added' | 'removed';
  optionalBefore: boolean;
  optionalAfter: boolean;
}

export interface SignatureComparison {
  parameters: ParameterComparison[];
  returnType: TypeRelation;
  /** The `this` parameter, when either side declares one. Types are printed for the reason text. */
  thisParameter?: { relation: TypeRelation | 'added' | 'removed'; before?: string; after?: string };
}

export interface TypeComparison {
  /** Relation of the whole types. For callables this is the function types compared. */
  relation: TypeRelation;
  /** True when both sides are callable (functions, methods, function-typed properties, call/construct signatures). */
  callable: boolean;
  /** Per-overload detail when every overload on both sides is non-generic and counts match. */
  signatures?: SignatureComparison[];
  /** Number of type parameters per overload on each side, for callables. */
  typeParameterCounts?: { before: number[]; after: number[] };
}

export interface CompareTypesInput {
  a: PackageDir;
  b: PackageDir;
  surfaceA: ApiSurface;
  surfaceB: ApiSurface;
  /** Canonical paths present in both surfaces whose textual signature differs. */
  paths: string[];
}

export interface CompileOptions {
  /** Used to fetch the target's own dependencies at versions satisfying its declared ranges. */
  fetcher?: PackageFetcher;
  /**
   * Repository-relative files that use the package (Signal A's answer). Only these and the
   * files importing them are type-checked; without it, every file is.
   */
  files?: string[];
  /**
   * Targets to link into the baseline as well (the @types release matching the installed
   * runtime, when the repository has a newer one installed), so both sides are compared on
   * the declarations they should have.
   */
  baselineTargets?: { name: string; dir: string; specifier?: string }[];
}

export interface LanguageAdapter {
  /** "typescript" */
  readonly id: string;
  extractSurface(input: PackageDir): Promise<ApiSurface>;
  /**
   * Optional. Compares the types behind same-path symbols with the language's type
   * checker. Paths the checker cannot resolve are simply absent from the result and fall
   * back to textual comparison.
   */
  compareTypes?(input: CompareTypesInput): Promise<Map<string, TypeComparison>>;
  /**
   * Milestone 2. Every usage of `pkg` in the repository, affected or not, each mapped to
   * a canonical path of `surface`. Matching usages to changes is language-agnostic and
   * lives in core.
   */
  findUsages?(repo: RepoDir, pkg: string, surface: ApiSurface): Promise<FindUsagesResult>;
  /**
   * Milestone 2, Signal B. Type-checks the repository with `pkg` resolved to
   * `targetDir` (an extracted tarball of the target version) and reports the errors that
   * appear. Read only; nothing in the repository or the package is executed.
   */
  /** Several targets in one overlay: a release group upgraded together. */
  compileAgainstMany?(
    repo: RepoDir,
    targets: { name: string; dir: string; specifier?: string }[],
    options?: CompileOptions,
  ): Promise<CompileSignal>;
  compileAgainst?(
    repo: RepoDir,
    pkg: string,
    targetDir: string,
    options?: CompileOptions,
  ): Promise<CompileSignal>;
  /**
   * Milestone 2. The repository's direct dependencies with their installed versions,
   * from whatever the ecosystem uses as the source of truth (the lockfile for npm).
   */
  installedDependencies?(repo: RepoDir): Promise<Map<string, string>>;
  /** Milestone 2. Package names the repository's sources import (any import form), for skipping the rest. */
  importedPackages?(repo: RepoDir): Promise<Set<string>>;
  /**
   * Milestone 2. The workspace packages under a root (pnpm-workspace.yaml, package.json
   * `workspaces`), as directories relative to it, the root itself included as `.`.
   */
  workspacePackages?(root: RepoDir): Promise<string[]>;
  /** Warnings about how the repository was loaded (stale workspace builds), to print under its packages. */
  repoWarnings?(repo: RepoDir): Promise<string[]>;
  /** name -> specifier as declared in the manifest (`^1.2.0`, `catalog:`, `workspace:*`). */
  declaredSpecifiers?(repo: RepoDir): Promise<Map<string, string>>;
  /** Release whatever the adapter cached for a repository (a parsed program is hundreds of MB). */
  forgetRepo?(repo: RepoDir): void;
}
