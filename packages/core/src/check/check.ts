import { readFileSync, realpathSync } from 'node:fs';
import { join, posix, relative, resolve, sep } from 'node:path';
import { typescriptAdapter } from '../adapters/typescript/index.js';
import { createFsSurfaceCache } from '../cache/fs-surface-cache.js';
import { diffDirs } from '../diff-package.js';
import type { LanguageAdapter, PackageDir, RepoDir } from '../domain/adapter.js';
import type { PackageFetcher, SurfaceCache } from '../domain/io.js';
import { parentOf } from '../domain/path.js';
import { type ProgressListener, progress } from '../domain/progress.js';
import type {
  CheckReport,
  Finding,
  Importer,
  PackageReport,
  PackageStatus,
  RuntimeReport,
} from '../domain/report.js';
import { type ApiSurface, SURFACE_SCHEMA_VERSION } from '../domain/surface.js';
import { type FindUsagesResult, repoTypeChecks, type Usage, usagePaths } from '../domain/usage.js';
import {
  AdapterCapabilityError,
  errorCode,
  NoTypesError,
  PackageNotFoundError,
  RegistryAuthError,
  UptideError,
} from '../errors.js';
import { createNpmFetcher, releasePackage } from '../fetch/npm-fetcher.js';
import { maxSatisfying } from '../fetch/range.js';
import { planPackage } from '../fix/plan.js';
import { scanImports } from '../list/scan.js';
import { packFixability } from '../packs/fixability.js';
import { activePacks } from '../packs/index.js';
import type { MigrationPack } from '../packs/types.js';
import { diffRuntime, probeRuntime } from '../runtime/runtime.js';
import { resetSharedState } from '../shared-state.js';
import { requireFindUsages } from './capabilities.js';
import { type CompanionPlan, companionsOf, type InstalledDependency } from './companions.js';
import { arbitrateUnchecked } from './file-kind.js';
import { groupName, releaseGroups } from './groups.js';
import { importedByText, importFileCounts } from './importers.js';
import { match } from './match.js';
import { estimateScopedHeapMb, freeMemoryBytes, memoryPolicy } from './memory.js';
import { mergeSignals } from './merge.js';
import {
  hasTopLevelAwait,
  moduleFormatChange,
  readManifest,
  requireEsmSupport,
  resolveNodeVersion,
  shipsTypes,
} from './module-format.js';
import { mapWithLimit, mapWithSerialRetry } from './pool.js';
import { isBehind, rankCandidates } from './rank.js';
import { foldSharedRoots, groupRootCauses } from './root-cause.js';
import { runtimeChangeFindings } from './runtime-changes.js';
import { confirmBreaking, evidenceOf, tierOf } from './tier.js';
import { typesPackageOf, typesReleaseFor } from './types-release.js';
import { unattributedFindings } from './unattributed.js';
import { verdictOf } from './verdict.js';
import { compareVersions, majorsBehind, parseVersion } from './version.js';

/**
 * Packs `check` can plan with; the same ones `fix` runs: the verified packs, unless the caller
 * names its own (`uptide pack test` scores a candidate with it).
 */
function packsOf(opts: Pick<CheckOptions, 'packs'>): readonly MigrationPack[] {
  return opts.packs ?? activePacks();
}

export interface CheckOptions {
  onProgress?: ProgressListener;
  cwd: string;
  adapter?: LanguageAdapter;
  fetcher?: PackageFetcher;
  cache?: SurfaceCache;
  /** Explicit targets by package name; anything else targets `latest`. */
  targets?: Record<string, string>;
  /** Restrict to these packages. */
  only?: string[];
  /** Run Signal B (compile against the target). Default true; it only runs for packages with at least one usage. */
  compile?: boolean;
  assignability?: boolean;
  /** Also analyze `@types/*` and dependencies the repo never imports. Default false. */
  allDeps?: boolean;
  /** Packages analyzed concurrently. Default 6. */
  concurrency?: number;
  /** Diff only the symbols the repo uses (and their parents and members). Default true; `uptide diff` keeps the full surface. */
  usageFirst?: boolean;
  /**
   * Run Signal C: load installed and target copies in a sandboxed child Node and diff what
   * they export. Default true. Nothing is installed and no install script ever runs.
   */
  runtime?: boolean;
  /**
   * Workspaces checked in parallel, each in a worker thread with its own program. The
   * default is selected from free memory and CPU count. Only
   * with the default adapter, fetcher and cache; injected ones stay in this thread.
   */
  workspaceConcurrency?: number;
  /** Internal memory reservation per worker. */
  workerHeapMb?: number;
  /** Attach the migration plan (`PackageReport.plan`). Default true; `fix` plans by doing. */
  plan?: boolean;
  /**
   * Time budget for the whole check. Dependencies are analyzed in order of likely impact
   * (see `rank.ts`); once the budget is spent no new one is started, and those left are
   * reported as skipped (`TIME_BUDGET`). What is already running gets half the budget again
   * to finish (the most likely to hurt started first, and is worth its answer), then is
   * abandoned at its next phase.
   */
  maxTimeMs?: number;
  /** Set by `check` for its workspace jobs: the analysis order. */
  order?: string[];
  /** Set by `check` for its workspace jobs: when no new dependency may start (epoch ms). */
  deadline?: number;
  /** Set by `check`: when a dependency still being analyzed is abandoned (epoch ms). */
  hardDeadline?: number;
  /** Set by `check` for its workspace jobs: the dependencies with something to analyze. */
  behind?: string[];
  /**
   * Set by `check`: for each package asked for by name, what moves with it (its group, at the
   * versions that agree with its target). Analyzed as one group led by it, as `fix` upgrades.
   */
  companions?: Record<string, CompanionPlan>;
  /**
   * The packs to use instead of the verified ones (`uptide pack test` passes a candidate).
   * Packs are code, which no worker receives: with this set, workspaces are checked in this
   * thread.
   */
  packs?: readonly MigrationPack[];
}

/** What a worker needs to check one workspace; everything is plain data. */
export interface WorkspaceJob {
  cwd: string;
  workspace: string;
  rootFiles?: string[];
  workspaces: string[];
  installedByWorkspace: Record<string, Record<string, string>>;
  /** Packages each workspace's own sources import, declared or not (a text scan). */
  importedByWorkspace: Record<string, string[]>;
  opts: Omit<CheckOptions, 'adapter' | 'fetcher' | 'cache' | 'onProgress' | 'packs'>;
}

export interface CheckResult extends CheckReport {
  timing: { totalMs: number };
}

/**
 * The milestone 2 pipeline over one repository or workspace: for every workspace package,
 * for every direct dependency with a newer version, diff installed against target, find
 * usages, compile against the target, join. Everything here is language-agnostic; the
 * adapter answers what a repository is.
 */
export async function check(opts: CheckOptions): Promise<CheckResult> {
  const started = Date.now();
  const adapter = opts.adapter ?? typescriptAdapter;
  const fetcher = opts.fetcher ?? createNpmFetcher();
  const cache = opts.cache ?? createFsSurfaceCache();
  const findUsages = requireFindUsages(adapter);
  if (!adapter.installedDependencies) throw new AdapterCapabilityError(adapter.id, 'findUsages');

  const root: RepoDir = { dir: opts.cwd };
  const workspaces = (await adapter.workspacePackages?.(root)) ?? ['.'];
  const memo = memoizingFetcher(fetcher);
  const installedByWorkspace: Record<string, Record<string, string>> = {};
  const catalogByWorkspace: Record<string, string[]> = {};
  for (const workspace of workspaces) {
    const repo = { dir: resolve(opts.cwd, workspace) };
    installedByWorkspace[workspace] = Object.fromEntries(await adapter.installedDependencies(repo));
    const specifiers = (await adapter.declaredSpecifiers?.(repo)) ?? new Map<string, string>();
    catalogByWorkspace[workspace] = [...specifiers]
      .filter(([, spec]) => spec.startsWith('catalog:'))
      .map(([name]) => name);
  }
  // What moves with each package asked for by name, analyzed with it at the versions that
  // agree with its target: the upgrade `fix` makes, not one no install ever produces.
  const plans = await companionPlans(opts, memo, adapter, workspaces, installedByWorkspace);
  const moving = Object.values(plans).flatMap((p) => p.companions);
  if (opts.only && moving.length > 0)
    opts = {
      ...opts,
      only: [...new Set([...opts.only, ...moving.map((c) => c.name)])],
      targets: { ...Object.fromEntries(moving.map((c) => [c.name, c.to])), ...opts.targets },
      companions: plans,
    };
  else if (Object.keys(plans).length > 0) opts = { ...opts, companions: plans };
  const ctx: Ctx = { adapter, fetcher: memo, cache, findUsages, opts };
  // Who imports what, whether or not they declare it: the candidates are the packages asked
  // for, or every package some workspace declares.
  const candidates = opts.only ?? [
    ...new Set(Object.values(installedByWorkspace).flatMap((deps) => Object.keys(deps))),
  ];
  const scopedImports =
    opts.only && !opts.adapter ? await scanImports(opts.cwd, candidates, workspaces) : undefined;
  const roots = new Map<string, string[]>();
  for (const workspace of workspaces) {
    const files = new Set<string>();
    for (const usage of scopedImports?.values() ?? [])
      for (const file of usage.files) {
        const owner =
          [...workspaces]
            .sort((a, b) => b.length - a.length)
            .find((w) => w !== '.' && file.startsWith(`${w}/`)) ?? '.';
        if (owner === workspace) files.add(resolve(opts.cwd, file));
      }
    if (scopedImports) roots.set(workspace, [...files].sort());
  }
  const importedByWorkspace: Record<string, string[]> = {};
  for (const workspace of workspaces)
    importedByWorkspace[workspace] = scopedImports
      ? candidates.filter((name) => scopedImports.get(name)?.workspaces.includes(workspace))
      : importedByText(opts.cwd, workspace, candidates, workspaces);
  // Most likely to hurt first: the order every workspace follows, and what the time budget cuts.
  const linked = (version: string | undefined): boolean =>
    version !== undefined && /^(link|workspace|file):/.test(version);
  const versionOf = (name: string): string | undefined =>
    Object.values(installedByWorkspace)
      .map((deps) => deps[name])
      .find((version) => version !== undefined && !linked(version));
  const rankable = candidates.filter(
    (name) =>
      !name.startsWith('@types/') &&
      versionOf(name) !== undefined &&
      (opts.allDeps || Object.values(importedByWorkspace).some((names) => names.includes(name))),
  );
  const sites = importFileCounts(opts.cwd, rankable);
  const ranked = rankCandidates(
    await mapWithLimit(rankable, 8, async (name) => {
      const latest =
        opts.targets?.[name] ?? (await ctx.fetcher.resolve(name, 'latest').catch(() => undefined));
      return {
        name,
        installed: versionOf(name) as string,
        ...(latest !== undefined ? { latest } : {}),
        importSites: sites.get(name) ?? 0,
      };
    }),
  );
  const { adapter: _a, fetcher: _f, cache: _c, onProgress: _p, packs: _k, ...givenOpts } = opts;
  const plainOpts: WorkspaceJob['opts'] = {
    ...givenOpts,
    // Compiler overlays share a workspace program; serialize them within its memory slot.
    concurrency: 1,
    targets: {
      ...Object.fromEntries(
        ranked.filter((c) => c.latest !== undefined).map((c) => [c.name, c.latest as string]),
      ),
      ...opts.targets,
    },
    order: ranked.map((c) => c.name),
    // A registry that did not answer is not "up to date": the package is still attempted.
    behind: ranked.filter((c) => c.latest === undefined || isBehind(c)).map((c) => c.name),
    ...(opts.maxTimeMs
      ? { deadline: started + opts.maxTimeMs, hardDeadline: started + opts.maxTimeMs * 1.5 }
      : {}),
  };
  // Heaviest workspaces first, so the last worker is not left alone with the largest one.
  // Under a budget, the workspaces that import the most of what is behind come first: a
  // workspace started after the deadline is not analyzed at all.
  const behindNames = new Set(plainOpts.behind ?? []);
  const stake = (workspace: string): number =>
    opts.maxTimeMs
      ? (importedByWorkspace[workspace] ?? []).filter((name) => behindNames.has(name)).length
      : 0;
  const jobs: WorkspaceJob[] = [...workspaces]
    .sort(
      (a, b) =>
        stake(b) - stake(a) ||
        Object.keys(installedByWorkspace[b] ?? {}).length -
          Object.keys(installedByWorkspace[a] ?? {}).length,
    )
    .map((workspace) => ({
      cwd: opts.cwd,
      workspace,
      ...(roots.has(workspace) ? { rootFiles: roots.get(workspace) as string[] } : {}),
      workspaces,
      installedByWorkspace,
      importedByWorkspace,
      opts: plainOpts,
    }));
  const injected =
    opts.adapter !== undefined ||
    opts.fetcher !== undefined ||
    opts.cache !== undefined ||
    opts.packs !== undefined;
  const estimates = new Map(
    jobs.map((job) => [
      job.workspace,
      injected || job.rootFiles?.length === 0
        ? 0
        : estimateScopedHeapMb(resolve(job.cwd, job.workspace), job.rootFiles),
    ]),
  );
  const policy = memoryPolicy(
    undefined,
    undefined,
    Math.min(
      opts.workspaceConcurrency ?? Number.MAX_SAFE_INTEGER,
      jobs.filter((j) => (estimates.get(j.workspace) ?? 0) > 0).length || 1,
    ),
    Math.max(1024, ...estimates.values()),
  );
  const workers = injected ? 1 : policy.workers;
  plainOpts.workerHeapMb = policy.heapMb;
  plainOpts.workspaceConcurrency = workers;
  // A workspace whose analysis dies (out of memory, a crash in a worker) costs that
  // workspace's answers, never the others': its dependencies are reported as failed.
  const guarded = (run: (job: WorkspaceJob) => Promise<PackageReport[]>) => (job: WorkspaceJob) =>
    (async () => {
      const estimate = estimates.get(job.workspace) ?? 0;
      const available = job.opts.workerHeapMb ?? policy.heapMb;
      const active = (importedByWorkspace[job.workspace] ?? []).some((name) =>
        behindNames.has(name),
      );
      if (!injected && (active || opts.allDeps) && estimate > available)
        throw new UptideError(
          'MEMORY_BUDGET',
          `workspace ${job.workspace}: scoped program estimate ${estimate} MB of heap; ${available} MB available for a single worker within the ${policy.budgetMb} MB memory budget (60% of available memory). Close other applications or check a smaller workspace.`,
        );
      return run(job);
    })().catch((err: unknown): PackageReport[] => {
      const declared = installedByWorkspace[job.workspace] ?? {};
      return (plainOpts.behind ?? [])
        .filter(
          (name) =>
            (declared[name] !== undefined || importedByWorkspace[job.workspace]?.includes(name)) &&
            !linked(declared[name]),
        )
        .map((name) => ({
          ...notImported(job.workspace, name, (declared[name] ?? versionOf(name) ?? '?') as string),
          target: plainOpts.targets?.[name] ?? declared[name] ?? '?',
          latest: plainOpts.targets?.[name] ?? declared[name] ?? '?',
          ...(declared[name] === undefined ? { undeclared: {} } : {}),
          status: 'skipped' as const,
          skipReason: errorCode(err),
          notes: [
            errorCode(err) === 'MEMORY_BUDGET'
              ? (err as Error).message
              : /memory/i.test(String((err as Error).message))
                ? `workspace ${job.workspace}: scoped program exhausted its memory reservation (estimate ${estimates.get(job.workspace) ?? 0} MB of heap; ${job.opts.workerHeapMb ?? policy.heapMb} MB available). No safety verdict; free more memory and retry.`
                : `analysis failed: ${(err as Error).message ?? String(err)}`,
          ],
        }));
    });
  const results = !injected
    ? await mapWithSerialRetry(
        jobs,
        workers,
        guarded((job) =>
          job.rootFiles?.length === 0 && !opts.allDeps
            ? checkWorkspace(ctx, job)
            : runInWorker(job, opts.onProgress),
        ),
        (reports) =>
          reports.some(
            (p) => p.skipReason === 'ERR_WORKER_OUT_OF_MEMORY' || p.skipReason === 'MEMORY_BUDGET',
          ),
        async (job) => {
          // The graph estimate cannot predict every expensive type instantiation. Retry
          // only after parallel jobs release memory, respecting the original reservation.
          const serial = memoryPolicy(undefined, 1, 1);
          const heapMb = Math.min(serial.heapMb, Math.floor(policy.budgetMb / 1.4));
          return guarded((retry) => runInWorker(retry, opts.onProgress))({
            ...job,
            opts: { ...job.opts, workspaceConcurrency: 1, workerHeapMb: heapMb },
          });
        },
      )
    : await mapWithLimit(
        jobs,
        1,
        guarded((job) => checkWorkspace(ctx, job)),
      );
  // Pack rules preview their actual edit; check and fix must promise the same work.
  if (adapter.id === 'typescript')
    for (const report of results.flat()) {
      // Packs whose rules carry their own rewrite (zod, and every pack built on the contract).
      const pack = packsOf(opts).find((p) => p.name === report.name);
      if (!pack || !(pack.rules as readonly { rewrite?: unknown }[]).some((r) => r.rewrite))
        continue;
      const sources = new Map<string, string>();
      report.findings = report.findings.map((finding) => {
        const file = resolve(opts.cwd, report.workspace, finding.usage.file);
        let source = sources.get(file);
        if (source === undefined) {
          try {
            source = readFileSync(file, 'utf8');
          } catch {
            return finding;
          }
          sources.set(file, source);
        }
        return packFixability(finding, source, pack);
      });
    }
  const order = new Map(workspaces.map((w, i) => [w, i]));
  const packages = mergeAcrossWorkspaces(
    results.flat().sort((a, b) => (order.get(a.workspace) ?? 0) - (order.get(b.workspace) ?? 0)),
    catalogByWorkspace,
  );
  for (const p of packages) p.tier ??= tierOf(packsOf(opts), p.name, p.installed, p.target);
  for (const p of packages) groupRootCauses(p);
  if (adapter.id === 'typescript' && opts.plan !== false) planPackages(packages, opts);
  else for (const p of packages) delete p.planContext;
  await ctx.fetcher.dispose();

  return {
    repo: opts.cwd,
    workspaces,
    packages,
    summary: summarize(packages),
    timing: { totalMs: Date.now() - started },
  };
}

/**
 * The migration plan per package: what `fix` would do, from a dry run of its pack, plus the
 * pack's note per rule (stripe: how many API changelog entries touch the code) from the
 * context each workspace gathered while it had the usages in hand.
 */
function planPackages(packages: PackageReport[], opts: CheckOptions): void {
  const sources = new Map<string, string | undefined>();
  const read = (file: string): string | undefined => {
    if (!sources.has(file)) {
      try {
        sources.set(file, readFileSync(resolve(opts.cwd, file), 'utf8'));
      } catch {
        sources.set(file, undefined);
      }
    }
    return sources.get(file);
  };
  for (const p of packages) {
    if (!['breaking', 'deprecated'].includes(p.status) && p.findings.length === 0) continue;
    const pack = packsOf(opts).find((candidate) => candidate.name === p.name);
    const plan = planPackage(p, pack, read, p.planContext ?? {});
    if (plan.length === 0) continue;
    p.plan = plan;
    if (!p.planContext) continue;
    const context = { from: p.installed, to: p.target, includeDeprecated: false, ...p.planContext };
    // A pack's own finding is worded once every workspace's evidence is in: the client created
    // in one package speaks for the fields another reads.
    if (pack?.describeFinding)
      for (const f of p.findings) {
        if (f.change.source !== 'pack') continue;
        const words = pack.describeFinding(f, context);
        if (words?.reason) f.reason = words.reason;
        if (words?.details?.length) f.details = words.details;
      }
    if (!pack?.planNote) continue;
    for (const group of plan) {
      if (group.severity === 'deprecated') continue;
      const note = pack.planNote(group.rule, context);
      if (note) group.note = note;
    }
  }
  for (const p of packages) delete p.planContext;
}

/** One workspace's relation to a package, for the report's list of importers. */
function importerOf(p: PackageReport): Importer {
  const analyzed = !['skipped', 'no-types', 'private', 'not-imported'].includes(p.status);
  return {
    workspace: p.workspace,
    declared: p.undeclared === undefined,
    ...(p.undeclared?.via ? { via: p.undeclared.via } : {}),
    analyzed,
    ...(analyzed ? {} : { reason: p.notes[0] ?? p.status }),
  };
}

/** A finding's weight in the counts: an anchor stands for the errors under it, never for itself. */
export function sitesOf(f: Finding): number {
  return f.change.kind === 'cause' && !f.anchorOnly ? (f.downstream?.length ?? 0) : 1;
}

/**
 * A dependency the run tried and could not analyze: the registry did not answer, the
 * tarball could not be fetched, or the analysis itself failed. Not a failure: no types to
 * diff, not installed, private, or left out by the time budget (each says so itself).
 */
export function isFailure(p: Pick<PackageReport, 'status' | 'skipReason'>): boolean {
  return (
    p.status === 'skipped' &&
    p.skipReason !== undefined &&
    ![
      'TIME_BUDGET',
      'NO_TYPES',
      'PACKAGE_NOT_INSTALLED',
      'PACKAGE_NOT_FOUND',
      'REGISTRY_AUTH',
    ].includes(p.skipReason)
  );
}

export function summarize(packages: PackageReport[]): CheckReport['summary'] {
  const byName = (status: (p: PackageReport) => boolean): number =>
    new Set(packages.filter(status).map((p) => p.name)).size;
  const findings = packages.flatMap((p) => p.findings);
  const count = (pick: (f: Finding) => boolean): number =>
    findings.filter(pick).reduce((n, f) => n + sitesOf(f), 0);
  return {
    packagesNeedingAttention: byName((p) => p.status === 'breaking' || p.status === 'deprecated'),
    breaking: count((f) => f.severity === 'breaking'),
    deprecated: count((f) => f.severity === 'deprecated'),
    unverified: count((f) => f.severity === 'unverified'),
    unaffected: byName((p) => p.status === 'safe'),
    notImported: byName((p) => p.status === 'not-imported'),
    partiallyAnalyzed: byName((p) => p.status === 'partial' || p.status === 'unknown'),
    autoFixable: count(
      (f) =>
        (f.severity === 'breaking' || f.severity === 'deprecated') && f.fixability === 'mechanical',
    ),
    skippedForTime: byName((p) => p.skipReason === 'TIME_BUDGET'),
    failed: byName((p) => isFailure(p)),
  };
}

/** One entry per compiler the workspaces were judged with. */
function uniqueCompilers(
  compilers: { version: string; own: boolean }[],
): { version: string; own: boolean }[] {
  const seen = new Map<string, { version: string; own: boolean }>();
  for (const c of compilers) seen.set(`${c.own}:${c.version}`, c);
  return [...seen.values()];
}

/**
 * One dependency, one decision. A dependency at the same installed version and target in
 * several workspaces (a pnpm catalog entry, or plain duplication) is one entry, with the
 * call sites of every workspace under it and their files prefixed with the workspace path.
 */
export function mergeAcrossWorkspaces(
  packages: PackageReport[],
  catalogByWorkspace: Record<string, string[]>,
): PackageReport[] {
  const analyzable = new Set<PackageStatus>([
    'breaking',
    'deprecated',
    'safe',
    'partial',
    'unknown',
  ]);
  const groups = new Map<string, PackageReport[]>();
  for (const p of packages) {
    if (!analyzable.has(p.status) || p.notes.includes('up to date')) continue;
    const key = `${p.name}@${p.installed}->${p.target}`;
    const list = groups.get(key) ?? [];
    list.push(p);
    groups.set(key, list);
  }
  const merged = new Map<PackageReport, PackageReport>();
  const dropped = new Set<PackageReport>();
  for (const list of groups.values()) {
    const catalog = list.some((p) => catalogByWorkspace[p.workspace]?.includes(p.name));
    if (list.length < 2 && !catalog) continue;
    // A cause in another workspace's source is reported relative to this one (`../editor/x.ts`):
    // normalized, it is the repository path.
    const prefixed = (p: PackageReport, file: string): string =>
      posix.normalize(p.workspace === '.' ? file : `${p.workspace}/${file}`);
    const first = list[0] as PackageReport;
    const sum = (pick: (p: PackageReport) => number): number =>
      list.reduce((n, p) => n + pick(p), 0);
    const workspaceOf = new WeakMap<Finding, string>();
    const findings = list.flatMap((p) =>
      p.findings.map((f) => {
        const moved: Finding = {
          ...f,
          usage: { ...f.usage, file: prefixed(p, f.usage.file) },
          ...(f.root ? { root: { ...f.root, file: prefixed(p, f.root.file) } } : {}),
          ...(f.downstream
            ? { downstream: f.downstream.map((d) => ({ workspace: p.workspace, ...d })) }
            : {}),
          // A cluster's description names its cause by file: the same prefix applies there.
          change: f.change.path.startsWith('cause:')
            ? {
                ...f.change,
                notes: f.change.notes?.replace(
                  `(${f.usage.file}:`,
                  `(${prefixed(p, f.usage.file)}:`,
                ),
              }
            : f.change,
        };
        workspaceOf.set(moved, p.workspace);
        return moved;
      }),
    );
    // Sites in several workspaces that trace to one declaration: one finding, at the declaration.
    const folded = foldSharedRoots(findings, (f) => workspaceOf.get(f));
    const combined: PackageReport = {
      ...first,
      workspace: '*',
      workspaces: list.map((p) => p.workspace),
      ...(catalog ? { source: 'catalog' as const } : {}),
      findings: folded,
      callSitesChecked: sum((p) => p.callSitesChecked),
      unanalyzed: list.flatMap((p) =>
        p.unanalyzed.map((u) => ({ ...u, file: prefixed(p, u.file) })),
      ),
      notes: [...new Set(list.flatMap((p) => p.notes))],
      ...(list.find((p) => p.skipReason)?.skipReason
        ? { skipReason: list.find((p) => p.skipReason)?.skipReason }
        : {}),
      status: statusOf(
        folded,
        sum((p) => p.callSitesChecked),
        sum((p) => p.unanalyzed.length),
      ),
      timing: {
        fetchMs: sum((p) => p.timing.fetchMs),
        diffMs: sum((p) => p.timing.diffMs),
        usagesMs: sum((p) => p.timing.usagesMs),
        compileMs: sum((p) => p.timing.compileMs),
        runtimeMs: sum((p) => p.timing.runtimeMs ?? 0),
      },
    };
    if (first.runtime) combined.runtime = first.runtime;
    // What moves with the package is one plan for the repository, carried by whichever
    // workspace reports it; the merged entry keeps every companion and conflict named.
    const companions = [
      ...new Map(
        list.flatMap((p) => p.companions ?? []).map((c) => [`${c.name}@${c.from}`, c]),
      ).values(),
    ].sort((a, b) => a.name.localeCompare(b.name) || a.from.localeCompare(b.from));
    const conflicts = [...new Set(list.flatMap((p) => p.companionConflicts ?? []))];
    if (companions.length > 0) combined.companions = companions;
    if (conflicts.length > 0) combined.companionConflicts = conflicts;
    const peerConflicts = [...new Set(list.flatMap((p) => p.peerConflicts ?? []))].sort();
    if (peerConflicts.length > 0) combined.peerConflicts = peerConflicts;
    const members = [
      ...new Map(list.flatMap((p) => p.members ?? []).map((m) => [m.name, m])).values(),
    ];
    if (members.length > 1) combined.members = members;
    combined.importers = list.map(importerOf);
    const contexts = list.map((p) => p.planContext).filter((c) => c !== undefined);
    if (contexts.length > 0) {
      combined.planContext = {
        ...contexts[0],
        evidence: contexts.flatMap((c) => c.evidence ?? []),
      };
    }
    const compiled = list.filter((p) => p.compile !== undefined);
    const firstCompiled = compiled[0];
    if (firstCompiled?.compile) {
      const coverages = compiled.map((p) => p.compile?.coverage).filter((c) => c !== undefined);
      const skipped = new Map<string, number>();
      for (const c of coverages)
        for (const r of c.skipped) skipped.set(r.reason, (skipped.get(r.reason) ?? 0) + r.count);
      const notCompiled = compiled.flatMap((p) =>
        (p.compile?.coverage?.notCompiled ?? []).map((n) => ({
          path: prefixed(p, n.path),
          reason: n.reason,
        })),
      );
      combined.compile = {
        ...firstCompiled.compile,
        // Skipped in one workspace, compiled in another: the coverage says how much of each.
        ...(compiled.some((p) => p.compile?.skipped === undefined) ? { skipped: undefined } : {}),
        baselineErrors: sum((p) => p.compile?.baselineErrors ?? 0),
        ...(coverages.length > 0
          ? {
              coverage: {
                compiled: coverages.reduce((n, c) => n + c.compiled, 0),
                total: coverages.reduce((n, c) => n + c.total, 0),
                workspaces: coverages.reduce((n, c) => n + c.workspaces, 0),
                skipped: [...skipped].map(([reason, count]) => ({ reason, count })),
                ...(notCompiled.length > 0 ? { notCompiled } : {}),
                ...(coverages.some((c) => c.compilers)
                  ? { compilers: uniqueCompilers(coverages.flatMap((c) => c.compilers ?? [])) }
                  : {}),
              },
            }
          : {}),
        unresolvedInTarget: [...new Set(list.flatMap((p) => p.compile?.unresolvedInTarget ?? []))],
        unresolvedFiles: [...new Set(list.flatMap((p) => p.compile?.unresolvedFiles ?? []))],
        unattributed: list.flatMap((p) =>
          (p.compile?.unattributed ?? []).map((d) => ({ ...d, file: prefixed(p, d.file) })),
        ),
        ...(compiled.every((p) => p.compile?.newErrors !== undefined)
          ? { newErrors: sum((p) => p.compile?.newErrors ?? 0) }
          : {}),
      };
      if (combined.compile.skipped === undefined) delete combined.compile.skipped;
    }
    // One verdict for the merged entry: its findings and compile summary are the union.
    if (list.some((p) => p.verdict))
      combined.verdict = verdictOf(
        combined,
        list.find((p) => p.verdict?.notVerified)?.verdict?.notVerified,
      );
    merged.set(first, combined);
    for (const p of list.slice(1)) dropped.add(p);
  }
  const shared: PackageReport[] = [];
  const rest: PackageReport[] = [];
  // A workspace that imports the package but could not be analyzed is listed under the
  // package's entry with its reason, never as a row of its own and never dropped.
  const failedImporters = packages.filter((p) => p.status === 'skipped' && p.undeclared);
  for (const p of packages) {
    if (dropped.has(p) || failedImporters.includes(p)) continue;
    const m = merged.get(p);
    if (m) shared.push(m);
    else rest.push(p);
  }
  const result = [...shared, ...rest];
  for (const p of result) {
    if (!analyzable.has(p.status)) continue;
    const importers = p.importers ?? [importerOf(p)];
    const failed = failedImporters.filter((f) => f.name === p.name).map(importerOf);
    // Several analyzed entries of one package (different versions) each carry the same failures.
    if (importers.length > 1 || failed.length > 0 || p.undeclared)
      p.importers = [...importers, ...failed];
  }
  const orphans = failedImporters.filter((f) => !result.some((p) => p.name === f.name));
  for (const f of orphans) f.importers = [importerOf(f)];
  return [...result, ...orphans];
}

/**
 * What one workspace worker may use: a type-checked program of a large workspace takes
 * gigabytes, and the analysis holds two (installed and target). At most 60% of available
 * memory across workers including overhead, capped at 8 GB each. Overrides can lower it.
 */
export function workerHeapMb(
  workers: number,
  freeBytes = freeMemoryBytes(),
  env = process.env,
): number {
  const budget = Math.floor(((freeBytes / 1024 / 1024) * 0.6) / Math.max(1, workers) / 1.4);
  const asked = Number(env.UPTIDE_WORKER_HEAP_MB);
  return Math.max(
    0,
    Math.min(8192, budget, Number.isFinite(asked) && asked >= 128 ? Math.floor(asked) : 8192),
  );
}

/** A worker thread checks one workspace with the default adapter, fetcher and cache. */
async function runInWorker(
  job: WorkspaceJob,
  onProgress?: ProgressListener,
): Promise<PackageReport[]> {
  const { Worker } = await import('node:worker_threads');
  const here = import.meta.url;
  // Built: dist/index.js next to dist/worker.js. Source (tests, tsx): the .ts entry through tsx.
  const fromSource = here.endsWith('.ts');
  const url = new URL(fromSource ? './worker.ts' : './worker.js', here);
  return new Promise((resolvePromise, reject) => {
    const worker = new Worker(url, {
      workerData: job,
      execArgv: fromSource ? ['--import', 'tsx'] : [],
      resourceLimits: {
        maxOldGenerationSizeMb: Math.max(16, job.opts.workerHeapMb ?? workerHeapMb(1)),
      },
    });
    let settled = false;
    worker.on('message', (message) => {
      if (message.type === 'error') {
        settled = true;
        void worker.terminate().then(() => reject(new UptideError(message.code, message.message)));
      } else if (message.type === 'progress') onProgress?.(message.event);
      else if (message.type === 'result') {
        settled = true;
        void worker.terminate().then(() => resolvePromise(message.reports));
      }
    });
    worker.once('error', (err) => {
      settled = true;
      void worker.terminate().then(() => reject(err));
    });
    worker.once('exit', (code) => {
      if (!settled) reject(new Error(`workspace ${job.workspace}: worker exited with ${code}`));
    });
  });
}

/** Entry for the worker thread and for the in-process path alike. */
export async function checkWorkspaceJob(
  job: WorkspaceJob,
  onProgress?: ProgressListener,
): Promise<PackageReport[]> {
  const adapter = typescriptAdapter;
  const ctx: Ctx = {
    adapter,
    fetcher: memoizingFetcher(createNpmFetcher()),
    cache: createFsSurfaceCache(),
    findUsages: requireFindUsages(adapter),
    opts: { ...job.opts, cwd: job.cwd, ...(onProgress ? { onProgress } : {}) },
  };
  try {
    return await checkWorkspace(ctx, job);
  } finally {
    await ctx.fetcher.dispose();
  }
}

/**
 * One workspace: every direct dependency, release groups upgraded together, the program
 * released at the end (it is hundreds of MB).
 */
async function checkWorkspace(ctx: Ctx, job: WorkspaceJob): Promise<PackageReport[]> {
  const { adapter } = ctx;
  // The job carries what `check` decided for every workspace: the order and the deadline.
  const opts: CheckOptions = { ...ctx.opts, ...job.opts };
  const { workspace, workspaces, installedByWorkspace, importedByWorkspace } = job;
  const packages: PackageReport[] = [];
  if (
    !opts.adapter &&
    opts.only &&
    !opts.allDeps &&
    (importedByWorkspace[workspace] ?? []).length === 0
  ) {
    return progress(opts.onProgress, { phase: 'resolve', workspace }, () =>
      Object.entries(installedByWorkspace[workspace] ?? {})
        .filter(([name]) => opts.only?.includes(name))
        .map(([name, version]) => notImported(workspace, name, version)),
    );
  }
  // Out of time before this workspace started: loading its program alone can take longer than
  // the budget. What it imports and is behind is reported as left out, from the manifests
  // and a text scan, without loading anything.
  if (opts.deadline !== undefined && Date.now() > opts.deadline) {
    const declared = installedByWorkspace[workspace] ?? {};
    const imported = new Set(importedByWorkspace[workspace] ?? []);
    const late = (name: string, version: string, undeclared: boolean): PackageReport => ({
      ...notImported(workspace, name, version),
      status: 'skipped',
      skipReason: 'TIME_BUDGET',
      notes: ['time budget reached before this workspace'],
      ...(undeclared ? { undeclared: {} } : {}),
    });
    for (const name of opts.behind ?? []) {
      if (opts.only && !opts.only.includes(name)) continue;
      const version = declared[name];
      if (version !== undefined && /^(link|workspace|file):/.test(version)) continue;
      if (version !== undefined && (opts.allDeps || imported.has(name)))
        packages.push(late(name, version, false));
      else if (version === undefined && imported.has(name))
        packages.push(late(name, 'unresolved', true));
    }
    return packages;
  }
  {
    const dir = resolve(opts.cwd, workspace);
    const repo: RepoDir = {
      dir,
      root: resolve(opts.cwd),
      ...(job.rootFiles ? { rootFiles: job.rootFiles } : {}),
    };
    const installed = new Map(Object.entries(installedByWorkspace[workspace] ?? {}));
    // Another workspace that declares the dependency itself answers for its own files, whether
    // nested under this one (the root's include) or pulled in through a project reference.
    const others = workspaces.filter(
      (w) => w !== workspace && !`${dir}/`.startsWith(`${resolve(opts.cwd, w)}/`),
    );
    // ...and so does one whose own sources import it without declaring it.
    const scopeFor = (name: string): RepoDir => {
      const exclude = others
        .filter(
          (w) =>
            installedByWorkspace[w]?.[name] !== undefined || importedByWorkspace[w]?.includes(name),
        )
        .map((w) => resolve(opts.cwd, w));
      return exclude.length > 0 ? { ...repo, exclude } : repo;
    };
    const imported = opts.allDeps
      ? undefined
      : await progress(opts.onProgress, { phase: 'resolve', workspace }, () =>
          adapter.importedPackages?.(repo),
        );
    // A workspace that imports a package it does not declare still runs against whatever it
    // resolves to (hoisted, or a workspace dependency's copy): the upgrade reaches it the same way.
    const undeclared = new Map<string, { via?: string }>();
    const unresolved = new Map<string, string>();
    for (const name of importedByWorkspace[workspace] ?? []) {
      if (installed.has(name) || name.startsWith('@types/')) continue;
      const dir = installedPackageDirOf(adapter, repo, name, '')?.dir;
      const version = dir ? readManifest(dir)?.version : undefined;
      if (!dir || !version) {
        unresolved.set(
          name,
          `imports ${name} without declaring it, and it does not resolve from ${workspace}`,
        );
        continue;
      }
      const via = [...installed]
        .filter(([, v]) => /^(link|workspace|file):/.test(v))
        .map(([dep]) => dep)
        .find((dep) => {
          const home = workspaces.find((w) => readManifest(resolve(opts.cwd, w))?.name === dep);
          return home !== undefined && installedByWorkspace[home]?.[name] !== undefined;
        });
      installed.set(name, version);
      undeclared.set(name, via ? { via } : {});
    }
    const rank = new Map((opts.order ?? []).map((name, i) => [name, i]));
    const entries = [...installed]
      .sort(
        ([a], [b]) =>
          (rank.get(a) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b) ?? Number.MAX_SAFE_INTEGER) ||
          a.localeCompare(b),
      )
      .filter(([name]) => !opts.only || opts.only.includes(name));
    const behind = new Set(opts.behind ?? []);
    // Release groups: same scope, same major, depending on one another, upgraded together.
    const analyzable = entries.filter(
      ([name, version]) =>
        !/^(link|workspace|file):/.test(version) &&
        (opts.allDeps ||
          (!name.startsWith('@types/') && (imported === undefined || imported.has(name)))),
    );
    let groups = releaseGroups(
      analyzable.map(([name, version]) => ({
        name,
        installed: version,
        dependsOn: dependsOnOf(installedPackageDirOf(adapter, repo, name, version)?.dir),
      })),
    );
    // A package asked for by name leads its companions' group, and absorbs any release group
    // one of them was in: one overlay with every target linked.
    for (const [lead, plan] of Object.entries(opts.companions ?? {})) {
      const members = [lead, ...plan.companions.map((c) => c.name)].filter((n) =>
        analyzable.some(([name]) => name === n),
      );
      if (!members.includes(lead) || members.length < 2) continue;
      for (const g of groups)
        if (g.some((m) => members.includes(m)))
          for (const m of g) if (!members.includes(m)) members.push(m);
      groups = [...groups.filter((g) => !g.some((m) => members.includes(m))), members];
    }
    const groupOf = new Map(groups.flatMap((g) => g.map((m) => [m, g] as const)));
    const done = new Set<string>();
    // The analysis is CPU-bound on one thread: six at once finish together, late, and each
    // holds a type-checked program of the whole workspace. Under a budget one at a time
    // finishes in rank order, so what the deadline cuts is the tail of the ranking, and the
    // memory in use is one target program, not six.
    const reports = await mapWithLimit(
      entries,
      opts.concurrency ?? (opts.deadline !== undefined ? 1 : 6),
      async ([name, installedVersion]): Promise<PackageReport[]> => {
        if (done.has(name)) return [];
        // Nothing to upgrade in a linked workspace package.
        if (/^(link|workspace|file):/.test(installedVersion)) {
          const linked: PackageReport = notImported(workspace, name, installedVersion);
          linked.status = 'workspace';
          linked.notes = [];
          return [linked];
        }
        // Type-only packages and dependencies nothing imports cannot affect a call site; say so instead of fetching them.
        if (
          !opts.allDeps &&
          (name.startsWith('@types/') || (imported !== undefined && !imported.has(name)))
        ) {
          return [notImported(workspace, name, installedVersion)];
        }
        const members = groupOf.get(name) ?? [name];
        // Out of time: what has something to analyze is left for a run that asks for it by
        // name. Up-to-date packages still answer (that costs one cached registry lookup).
        if (opts.deadline !== undefined && Date.now() > opts.deadline && behind.has(name)) {
          for (const m of members) done.add(m);
          return members.map((m) => ({
            ...notImported(workspace, m, installed.get(m) as string),
            status: 'skipped' as const,
            skipReason: 'TIME_BUDGET' as const,
            notes: ['time budget reached before this dependency'],
          }));
        }
        for (const m of members) done.add(m);
        try {
          return [
            await checkGroup(
              { ...ctx, opts },
              scopeFor(name),
              workspace,
              members.map((m) => ({ name: m, installed: installed.get(m) as string })),
            ),
          ];
        } catch (err) {
          // One dependency that cannot be analyzed is one answer missing, not all of them,
          // and leaves nothing behind: whatever shared TypeScript state it was inside is
          // discarded before the next package (shared-state.ts).
          resetSharedState();
          const late = errorCode(err) === 'TIME_BUDGET';
          return members.map((m) => ({
            ...notImported(workspace, m, installed.get(m) as string),
            status: 'skipped' as const,
            target: opts.targets?.[m] ?? installed.get(m) ?? '?',
            latest: opts.targets?.[m] ?? installed.get(m) ?? '?',
            skipReason: /Maximum call stack size exceeded/.test(String(err))
              ? 'ANALYSIS_STACK_OVERFLOW'
              : errorCode(err),
            notes: [
              /Maximum call stack size exceeded/.test(String(err))
                ? `${m}: analysis exceeded its recursion limit while inspecting declarations (Maximum call stack size exceeded). No safety verdict; other named packages continue.`
                : late
                  ? 'time budget reached during its analysis'
                  : `analysis failed: ${(err as Error).message ?? String(err)}`,
            ],
          }));
        }
      },
    );
    const warnings = (await adapter.repoWarnings?.(repo)) ?? [];
    for (const r of reports.flat()) {
      if (r.status === 'breaking' || r.status === 'deprecated' || r.status === 'safe') {
        r.notes.push(...warnings);
      }
      const undeclaredAs = undeclared.get(r.name);
      if (undeclaredAs) r.undeclared = undeclaredAs;
    }
    // Analyzed in order of impact, reported in a stable one.
    packages.push(...reports.flat().sort((x, y) => x.name.localeCompare(y.name)));
    for (const [name, reason] of unresolved) {
      if (opts.only && !opts.only.includes(name)) continue;
      packages.push({
        ...notImported(workspace, name, 'unresolved'),
        status: 'skipped',
        skipReason: 'PACKAGE_NOT_INSTALLED',
        undeclared: {},
        notes: [reason],
      });
    }
    adapter.forgetRepo?.(repo);
  }
  return packages;
}

/** Dependencies and peer dependencies named by an installed package's manifest. */
function dependsOnOf(dir: string | undefined): string[] {
  if (!dir) return [];
  try {
    const m = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    return [...Object.keys(m.dependencies ?? {}), ...Object.keys(m.peerDependencies ?? {})];
  } catch {
    return [];
  }
}

interface Ctx {
  adapter: LanguageAdapter;
  fetcher: RunFetcher;
  cache: SurfaceCache;
  findUsages: ReturnType<typeof requireFindUsages>;
  opts: CheckOptions;
}

interface RunFetcher extends PackageFetcher {
  /** Removes every directory extracted during the run. */
  dispose(): Promise<void>;
}

/**
 * One run asks the registry each question once: `latest` per dependency, the version list
 * per package, and one extraction per `name@version`, however many workspaces or target
 * dependency graphs need it. Extracted directories live until the run ends.
 */
/**
 * For each package `check` was asked about by name, what has to move with it: its group as
 * `list` draws it, at the versions that agree with its target (`companions.ts`). From the
 * manifests installed in the workspaces that declare it, and one packument per candidate.
 */
async function companionPlans(
  opts: CheckOptions,
  fetcher: RunFetcher,
  adapter: LanguageAdapter,
  workspaces: string[],
  installedByWorkspace: Record<string, Record<string, string>>,
): Promise<Record<string, CompanionPlan>> {
  const plans: Record<string, CompanionPlan> = {};
  const manifests = fetcher.manifests;
  if (!opts.only || !manifests) return plans;
  const linked = (version: string) => /^(link|workspace|file):/.test(version);
  for (const lead of opts.only) {
    const declaring = workspaces.filter((w) => {
      const version = installedByWorkspace[w]?.[lead];
      return version !== undefined && !linked(version);
    });
    if (declaring.length === 0) continue;
    const target =
      opts.targets?.[lead] ?? (await fetcher.resolve(lead, 'latest').catch(() => undefined));
    if (!target) continue;
    // Every workspace's dependencies: a companion may be declared above the workspace that
    // declares the lead (`@types/react` at the root, hoisted for the app that has `react`);
    // `companionsOf` decides which of them a workspace of the lead can see.
    const installed = new Map<string, InstalledDependency>();
    for (const workspace of workspaces)
      for (const [name, version] of Object.entries(installedByWorkspace[workspace] ?? {})) {
        if (linked(version)) continue;
        const known = installed.get(`${name}@${version}`);
        if (known) {
          known.workspaces.push(workspace);
          continue;
        }
        // Read from disk as Node would resolve it: loading a program for every workspace
        // just to find a manifest is what a 28-workspace repository cannot afford.
        const cheap = (
          adapter as {
            installedPackageDirCheap?: (repo: RepoDir, pkg: string) => string | undefined;
          }
        ).installedPackageDirCheap;
        const dir = cheap
          ? cheap({ dir: resolve(opts.cwd, workspace) }, name)
          : installedPackageDirOf(adapter, { dir: resolve(opts.cwd, workspace) }, name, version)
              ?.dir;
        let manifest = {};
        try {
          if (dir) manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
        } catch {
          // Unreadable: it can still be named in another package's manifest.
        }
        installed.set(`${name}@${version}`, { name, version, manifest, workspaces: [workspace] });
      }
    try {
      const plan = await companionsOf({
        name: lead,
        target,
        installed: [...installed.values()],
        manifests: (name) => manifests(name),
        lockstep: (packsOf(opts).find((p) => p.name === lead)?.companions ?? []).map((c) => c.name),
      });
      if (plan.companions.length > 0 || plan.conflicts.length > 0 || plan.peerConflicts.length > 0)
        plans[lead] = plan;
    } catch {
      // A registry that cannot answer leaves the package alone, as before.
    }
  }
  return plans;
}

function memoizingFetcher(inner: PackageFetcher): RunFetcher {
  const resolved = new Map<string, Promise<string>>();
  const versions = new Map<string, Promise<string[]>>();
  const manifests = new Map<
    string,
    Promise<Awaited<ReturnType<NonNullable<PackageFetcher['manifests']>>>>
  >();
  const fetched = new Map<string, Promise<PackageDir>>();
  const once = <T>(
    map: Map<string, Promise<T>>,
    key: string,
    make: () => Promise<T>,
  ): Promise<T> => {
    let p = map.get(key);
    if (!p) {
      p = make();
      map.set(key, p);
    }
    return p;
  };
  return {
    resolve: (name, requested) =>
      once(resolved, `${name}@${requested}`, () => inner.resolve(name, requested)),
    fetch: (name, version) => once(fetched, `${name}@${version}`, () => inner.fetch(name, version)),
    ...(inner.versions
      ? {
          versions: (name: string) =>
            once(versions, name, () => inner.versions?.(name) ?? Promise.resolve([])),
        }
      : {}),
    ...(inner.manifests
      ? {
          manifests: (name: string) =>
            once(manifests, name, () => inner.manifests?.(name) ?? Promise.resolve({})),
        }
      : {}),
    async dispose() {
      for (const dir of fetched.values()) {
        await dir.then((pkg) => releasePackage(inner, pkg)).catch(() => undefined);
      }
    },
  };
}

function notImported(workspace: string, name: string, installed: string): PackageReport {
  return {
    workspace,
    name,
    installed,
    latest: installed,
    target: installed,
    majorsBehind: 0,
    findings: [],
    callSitesChecked: 0,
    unanalyzed: [],
    status: 'not-imported',
    notes: [
      name.startsWith('@types/')
        ? 'type-only package, skipped'
        : 'never imported by this workspace, skipped',
    ],
    timing: { fetchMs: 0, diffMs: 0, usagesMs: 0, compileMs: 0 },
  };
}

/** The share of sites not analyzed above which a green verdict would be a guess. */
export const UNKNOWN_SHARE = 0.2;

export function statusOf(findings: Finding[], analyzed = 0, unanalyzed = 0): PackageStatus {
  if (findings.some((f) => f.severity === 'breaking')) return 'breaking';
  if (findings.some((f) => f.severity === 'deprecated')) return 'deprecated';
  if (unanalyzed === 0) return 'safe';
  // "No impact" is a statement about every site; sites nobody looked at cannot back it.
  return unanalyzed / (analyzed + unanalyzed) > UNKNOWN_SHARE ? 'unknown' : 'partial';
}

/**
 * The used paths and their ancestors: the only part of the surface a consumer can be
 * affected by. Members are added only under containers the consumer implements, where
 * every member is a contract; a class the consumer merely constructs does not drag its
 * hundreds of methods into the comparison (ioredis: five seconds of assignability checks
 * for twenty call sites).
 */
function pathsOfInterest(usages: Usage[], all: Iterable<string>): Set<string> {
  const out = new Set<string>();
  const known = new Set(all);
  const implemented = new Set<string>();
  for (const u of usages) {
    for (const path of usagePaths(u)) {
      out.add(path);
      for (let p = parentOf(path); p !== undefined; p = parentOf(p)) out.add(p);
      if (u.access === 'implement') implemented.add(path);
    }
  }
  if (implemented.size > 0) {
    for (const path of known) {
      for (let p = parentOf(path); p !== undefined; p = parentOf(p)) {
        if (implemented.has(p)) {
          out.add(path);
          break;
        }
      }
    }
  }
  return out;
}

/** Everything Signal A needs before a target is fetched, or the report that says why not. */
interface Prepared {
  name: string;
  installedVersion: string;
  latest: string;
  /** The installed version ships no declarations: no surface, no diff; loads and manifests still count. */
  untyped?: true;
  /** Declarations come from DefinitelyTyped: `installedDir` is the @types package, these are its versions. `baseline` when it differs from what is installed. */
  types?: { name: string; installedVersion: string; target: string; baseline?: string };
  /** The runtime package's directory when `installedDir` is the @types package (for the manifest). */
  runtimeDir?: PackageDir;
  target: string;
  installedDir: PackageDir;
  installedSurface: ApiSurface;
  scan: FindUsagesResult;
  notes: string[];
  timing: PackageReport['timing'];
  /** Used path -> referenced type paths, filled when the diff runs. */
  references?: Map<string, string[]>;
  /** Signal C, filled in checkGroup once the target is fetched. */
  runtime?: RuntimeReport;
}

const TYPE_WORDS = new Set([
  'string',
  'number',
  'boolean',
  'unknown',
  'any',
  'never',
  'void',
  'null',
  'undefined',
  'object',
  'symbol',
  'bigint',
  'this',
  'readonly',
  'typeof',
  'keyof',
  'infer',
  'extends',
  'new',
  'import',
  'Promise',
  'Array',
  'Record',
  'Partial',
  'Required',
  'Readonly',
  'Pick',
  'Omit',
  'Map',
  'Set',
]);

/**
 * Used path -> paths of the types its signature names, resolved against the surface: an
 * identifier `X` in the signature of `Stripe.StripeConfig#apiVersion` is `Stripe.X` if that
 * exists, else `X`. One level only: what a used symbol is declared to be.
 */
function referencedTypes(
  usages: Usage[],
  symbols: Map<string, { signature: string }>,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const u of usages) {
    for (const path of usagePaths(u)) {
      if (out.has(path)) continue;
      const symbol = symbols.get(path);
      if (!symbol) continue;
      const top = path.split(/[.#[]/)[0] ?? '';
      const prefixes = top && top !== path ? [top] : [];
      const refs = new Set<string>();
      for (const id of symbol.signature.match(/[A-Za-z_$][\w$]*/g) ?? []) {
        if (TYPE_WORDS.has(id)) continue;
        for (const candidate of [...prefixes.map((pre) => `${pre}.${id}`), id]) {
          if (candidate !== path && symbols.has(candidate)) {
            refs.add(candidate);
            break;
          }
        }
      }
      if (refs.size > 0) out.set(path, [...refs]);
    }
  }
  return out;
}

async function prepare(
  ctx: Ctx,
  repo: RepoDir,
  workspace: string,
  name: string,
  installedVersion: string,
): Promise<Prepared | PackageReport> {
  const timing = { fetchMs: 0, diffMs: 0, usagesMs: 0, compileMs: 0 };
  const notes: string[] = [];
  const base = (status: PackageStatus, target: string, latest: string): PackageReport => ({
    workspace,
    name,
    installed: installedVersion,
    latest,
    target,
    majorsBehind: majorsBehind(installedVersion, target),
    findings: [],
    callSitesChecked: 0,
    unanalyzed: [],
    status,
    notes,
    timing,
  });

  let latest: string;
  try {
    latest = await progress(
      ctx.opts.onProgress,
      { phase: 'resolve', package: name, workspace },
      () => ctx.fetcher.resolve(name, 'latest'),
    );
  } catch (err) {
    if (err instanceof PackageNotFoundError || err instanceof RegistryAuthError) {
      notes.push(err instanceof RegistryAuthError ? 'registry auth' : 'not on the registry');
      return { ...base('private', installedVersion, installedVersion), skipReason: errorCode(err) };
    }
    notes.push(`could not resolve latest: ${(err as Error).message}`);
    return { ...base('skipped', installedVersion, installedVersion), skipReason: errorCode(err) };
  }
  const target = ctx.opts.targets?.[name] ?? latest;
  if (compareVersions(target, installedVersion) <= 0) {
    notes.push('up to date');
    return base('safe', target, latest);
  }

  let installedDir = installedPackageDirOf(ctx.adapter, repo, name, installedVersion);
  const nodeTypes = installedPackageDirOf(ctx.adapter, repo, '@types/node', '')?.dir;
  if (installedDir && nodeTypes) installedDir.types = [nodeTypes];
  // Typed through DefinitelyTyped: the surface to diff is @types/<name>'s, at the version matching the target's major.
  const typesName = typesPackageOf(name);
  const typesDir = installedPackageDirOf(ctx.adapter, repo, typesName, '');
  let types: Prepared['types'];
  let runtimeDir: PackageDir | undefined;
  if (typesDir && (!installedDir || !shipsTypes(installedDir.dir))) {
    const typesInstalled = readManifest(typesDir.dir)?.version ?? '0.0.0';
    const major = parseVersion(target)?.major;
    const published = (await ctx.fetcher.versions?.(typesName).catch(() => [])) ?? [];
    // The @types release that types the target (its major.minor, else its major; never below
    // what is installed: @types/passport 1.x types passport 0.x), else the latest release. A
    // companion plan that moves the types package names the release outright.
    const typesTarget =
      ctx.opts.targets?.[typesName] ??
      typesReleaseFor(published, target, typesInstalled) ??
      typesInstalled;
    if (major !== undefined && parseVersion(typesTarget)?.major !== major && published.length > 0)
      notes.push(
        `${typesName} has no ${major}.x release above ${typesInstalled}; diffed against ${typesTarget}`,
      );
    types = { name: typesName, installedVersion: typesInstalled, target: typesTarget };
    runtimeDir = installedDir;
    installedDir = { ...typesDir, version: typesInstalled };
    // The baseline follows the runtime: express 4 is compared from @types/express 4.x even when
    // the repository has @types/express 5 installed, and that mismatch is worth a warning of its own.
    const runtimeMajor = parseVersion(installedVersion)?.major;
    const installedTypesMajor = parseVersion(typesInstalled)?.major;
    if (
      runtimeMajor !== undefined &&
      installedTypesMajor !== undefined &&
      runtimeMajor !== installedTypesMajor &&
      // Only the pre-upgraded case (express 4 running, @types/express 5 installed): @types
      // majors of 0.x packages do not track the runtime, and re-baselining them would invent diffs.
      installedTypesMajor === parseVersion(target)?.major
    ) {
      const matching = maxSatisfying(published, `${runtimeMajor}.x`);
      notes.push(
        `${typesName} ${typesInstalled} is installed while ${name} ${installedVersion} runs${matching ? `; baseline taken as ${typesName} ${matching}` : ''}`,
      );
      if (matching !== undefined && matching !== typesInstalled) {
        try {
          const baselineDir = await progress(
            ctx.opts.onProgress,
            { phase: 'fetch', package: name, workspace },
            () => ctx.fetcher.fetch(typesName, matching),
          );
          types.baseline = matching;
          installedDir = { ...baselineDir, version: matching };
        } catch {
          notes.push(
            `${typesName} ${matching} could not be fetched; baseline stays ${typesInstalled}`,
          );
        }
      }
    }
    if (nodeTypes) installedDir.types = [nodeTypes];
  }
  if (!installedDir) {
    notes.push('not installed: declared in the lockfile, missing from node_modules');
    return { ...base('skipped', target, latest), skipReason: 'PACKAGE_NOT_INSTALLED' };
  }

  // Signal A first, against the installed surface: what the repo uses bounds what can affect it.
  let installedSurface: ApiSurface;
  let untyped = false;
  try {
    // The baseline surface is whatever directory stands for the installed side (the @types
    // release of the runtime major when the repository has another one installed).
    const key = {
      package: installedDir.name,
      version: installedDir.version,
      adapter: ctx.adapter.id,
      schema: SURFACE_SCHEMA_VERSION,
    };
    installedSurface =
      (await ctx.cache.get(key)) ?? (await ctx.adapter.extractSurface(installedDir));
    await ctx.cache.set(key, installedSurface);
  } catch (err) {
    if (!(err instanceof NoTypesError)) throw err;
    // No declarations to diff; the load sites and the manifests are still analyzable.
    untyped = true;
    installedSurface = {
      package: name,
      version: installedVersion,
      extractedAt: new Date(0).toISOString(),
      adapter: ctx.adapter.id,
      symbols: [],
    };
  }
  const tUsages = Date.now();
  const scan = await progress(
    ctx.opts.onProgress,
    { phase: 'usages', package: name, workspace },
    () => ctx.findUsages(repo, name, installedSurface),
  );
  timing.usagesMs = Date.now() - tUsages;
  if (scan.unanalyzed.length > 0)
    notes.push(
      `${scan.unanalyzed.length} site${scan.unanalyzed.length === 1 ? '' : 's'} not analyzed (require/dynamic import)`,
    );
  if (scan.usages.length === 0) {
    if (scan.unanalyzed.length > 0) {
      // Every site is one nobody analyzed: not "unused", unknown.
      const report = base('unknown', target, latest);
      report.unanalyzed = scan.unanalyzed;
      return report;
    }
    // Imported somewhere (or only by a nested workspace that answers for itself), never used here.
    notes.push('no usages found');
    const report = base('not-imported', target, latest);
    report.unanalyzed = scan.unanalyzed;
    return report;
  }
  for (const u of scan.usages) u.package = name;
  const prepared: Prepared = {
    name,
    installedVersion,
    latest,
    target,
    installedDir,
    installedSurface,
    scan,
    notes,
    timing,
  };
  if (untyped) prepared.untyped = true;
  if (types) {
    prepared.types = types;
    if (runtimeDir) prepared.runtimeDir = runtimeDir;
  }
  return prepared;
}

/**
 * One dependency, or a release group: Signal A per member, one diff per member, one
 * overlay with every target linked, findings per member, one report.
 */
/**
 * Between the phases of one dependency (fetch, diff, compile, runtime probe): past the hard
 * deadline (the budget and half again), the dependency is abandoned rather than finished. A
 * phase that is running is not interrupted, so a run ends within one phase of that.
 */
function outOfTime(ctx: Ctx): void {
  if (ctx.opts.hardDeadline !== undefined && Date.now() > ctx.opts.hardDeadline)
    throw new UptideError('TIME_BUDGET', 'time budget reached');
}

async function checkGroup(
  ctx: Ctx,
  repo: RepoDir,
  workspace: string,
  members: { name: string; installed: string }[],
): Promise<PackageReport> {
  const prepared: Prepared[] = [];
  const early: PackageReport[] = [];
  for (const m of members) {
    const p = await prepare(ctx, repo, workspace, m.name, m.installed);
    if ('scan' in p) prepared.push(p);
    else early.push(p);
  }
  // A member with nothing to analyze (up to date, unused, unanalyzable) leaves the group; a lone package reports as itself.
  if (prepared.length === 0)
    return early.length === 1 ? (early[0] as PackageReport) : mergeEarly(workspace, early);
  // Led by the package asked for, when its companions are in the group: it names the report,
  // and its versions are the upgrade's.
  const plans = ctx.opts.companions ?? {};
  // A package asked for by name carries its plan even where it is analyzed alone: what moves
  // with it is one decision for the repository, whichever workspace the report comes from.
  const leader = prepared.find((p) => plans[p.name] !== undefined);
  const plan = leader ? plans[leader.name] : undefined;
  const name = leader && prepared.length > 1 ? leader.name : groupName(prepared.map((p) => p.name));
  const notes = prepared.flatMap((p) =>
    prepared.length > 1 ? p.notes.map((n) => `${p.name}: ${n}`) : p.notes,
  );
  const timing: PackageReport['timing'] = { fetchMs: 0, diffMs: 0, usagesMs: 0, compileMs: 0 };
  for (const p of prepared) timing.usagesMs += p.timing.usagesMs;
  const installed = prepared.map((p) => p.installedVersion).sort(compareVersions);
  const targets = prepared.map((p) => p.target).sort(compareVersions);
  const base = (status: PackageStatus): PackageReport => ({
    workspace,
    name,
    ...(prepared.length > 1
      ? {
          members: prepared.map((p) => ({
            name: p.name,
            installed: p.installedVersion,
            target: p.target,
          })),
        }
      : {}),
    installed: (leader?.installedVersion ?? installed[0]) as string,
    latest: (leader?.latest ??
      (prepared.length === 1 ? prepared[0]?.latest : targets.at(-1))) as string,
    target: (leader?.target ??
      (prepared.length === 1 ? prepared[0]?.target : targets.at(-1))) as string,
    ...(plan?.companions.length ? { companions: plan.companions } : {}),
    ...(plan?.conflicts.length ? { companionConflicts: plan.conflicts } : {}),
    ...(plan?.peerConflicts.length ? { peerConflicts: plan.peerConflicts } : {}),
    majorsBehind: Math.max(...prepared.map((p) => majorsBehind(p.installedVersion, p.target))),
    findings: [],
    callSitesChecked: 0,
    unanalyzed: prepared.flatMap((p) => p.scan.unanalyzed),
    status,
    notes,
    timing,
  });

  const tFetch = Date.now();
  const fetched: { p: Prepared; pkg: PackageDir; runtime?: PackageDir }[] = [];
  for (const p of prepared) {
    try {
      // With DefinitelyTyped, the declarations diffed are @types/<name>'s; the runtime package is fetched for its manifest.
      const pkg = p.types
        ? await progress(ctx.opts.onProgress, { phase: 'fetch', package: p.name, workspace }, () =>
            ctx.fetcher.fetch(p.types?.name ?? p.name, p.types?.target ?? p.target),
          )
        : await progress(ctx.opts.onProgress, { phase: 'fetch', package: p.name, workspace }, () =>
            ctx.fetcher.fetch(p.name, p.target),
          );
      const runtime = p.types
        ? await progress(ctx.opts.onProgress, { phase: 'fetch', package: p.name, workspace }, () =>
            ctx.fetcher.fetch(p.name, p.target),
          )
        : undefined;
      fetched.push({
        p,
        pkg: p.installedDir.types ? { ...pkg, types: p.installedDir.types } : pkg,
        runtime,
      });
    } catch (err) {
      notes.push(`could not fetch ${p.name}@${p.target}: ${(err as Error).message}`);
      return { ...base('skipped'), skipReason: errorCode(err) };
    }
  }
  timing.fetchMs = Date.now() - tFetch;
  const node = resolveNodeVersion([repo.dir, ctx.opts.cwd]);
  const nodeRange = node?.range;
  const nodeSupport = requireEsmSupport(nodeRange);
  try {
    outOfTime(ctx);
    const tDiff = Date.now();
    const diffs = new Map<string, Awaited<ReturnType<typeof diffDirs>>>();
    for (const { p, pkg } of fetched) {
      const meta = { package: p.name, from: p.installedVersion, to: p.target };
      const installedManifest = readManifest((p.runtimeDir ?? p.installedDir).dir);
      const targetManifest = readManifest(fetched.find((f) => f.p === p)?.runtime?.dir ?? pkg.dir);
      let diff: Awaited<ReturnType<typeof diffDirs>>;
      if (p.untyped) {
        const targetTyped = shipsTypes(pkg.dir, targetManifest);
        notes.push(
          `${prepared.length > 1 ? `${p.name}: ` : ''}installed ${p.installedVersion} ships no type declarations${targetTyped ? `, ${p.target} does` : ` and neither does ${p.target}`}; only load sites and the manifest were analyzed`,
        );
        diff = { surfaceA: p.installedSurface, surfaceB: p.installedSurface, changes: [] };
      } else {
        const bySymbol = new Map(p.installedSurface.symbols.map((s) => [s.path, s]));
        p.references = referencedTypes(p.scan.usages, bySymbol);
        const onlyPaths =
          ctx.opts.usageFirst === false
            ? undefined
            : new Set([
                ...pathsOfInterest(p.scan.usages, bySymbol.keys()),
                ...[...p.references.values()].flat(),
              ]);
        diff = await progress(
          ctx.opts.onProgress,
          { phase: 'diff', package: p.name, workspace },
          () =>
            diffDirs(p.installedDir, pkg, {
              adapter: ctx.adapter,
              cache: ctx.cache,
              assignability: ctx.opts.assignability,
              onlyPaths,
            }),
        );
      }
      // The manifests see what declarations cannot: the package going ESM-only.
      if (installedManifest && targetManifest) {
        const targetDir = fetched.find((f) => f.p === p)?.runtime?.dir ?? pkg.dir;
        const format = moduleFormatChange(installedManifest, targetManifest, meta, {
          range: nodeRange,
          support: nodeSupport,
          ...(node ? { source: node.caveat ? `${node.source}; ${node.caveat}` : node.source } : {}),
          topLevelAwait: nodeSupport === 'yes' && hasTopLevelAwait(targetDir),
        });
        if (format) {
          format.loadRoot = loadRootOf(p);
          diff = { ...diff, changes: [...diff.changes, format] };
        }
      }
      diffs.set(p.name, diff);
    }
    timing.diffMs = Date.now() - tDiff;

    const allUsages = prepared.flatMap((p) => p.scan.usages);
    let compile: PackageReport['compile'];
    let usages = allUsages;
    let compiled = false;
    const compileMany = ctx.adapter.compileAgainstMany;
    let linkedDirs: Record<string, string> = {};
    // Declarations identical on both sides (the same @types release) leave the compiler nothing to judge.
    const sameDeclarations = prepared.every(
      (p) =>
        p.types !== undefined && p.types.target === (p.types.baseline ?? p.types.installedVersion),
    );
    if (sameDeclarations) notes.push('type declarations unchanged; compile check skipped');
    if (ctx.opts.compile !== false && compileMany && !sameDeclarations) {
      outOfTime(ctx);
      const t2 = Date.now();
      // The baseline overlay links what the installed side is: the installed copy, or the
      // @types release the installed runtime should have.
      const baselineTargets = prepared.map((p) => ({
        name: p.types?.name ?? p.name,
        dir: p.installedDir.dir,
        specifier: p.name,
      }));
      const signal = await progress(
        ctx.opts.onProgress,
        { phase: 'compile', package: prepared.map((p) => p.name).join(', '), workspace },
        () =>
          compileMany(
            repo,
            fetched.map(({ p, pkg }) =>
              p.types
                ? { name: p.types.name, dir: pkg.dir, specifier: p.name }
                : { name: p.name, dir: pkg.dir },
            ),
            {
              fetcher: ctx.fetcher,
              files: [
                ...new Set([
                  ...allUsages.map((u) => u.file),
                  // A removed JSX/import binding can have no attributed usage. Every scoped
                  // importer must still receive baseline/target diagnostics.
                  ...(repo.rootFiles ?? []).map((file) => relative(repo.dir, file)),
                ]),
              ],
              ...(baselineTargets.length > 0 ? { baselineTargets } : {}),
            },
          ),
      );
      timing.compileMs = Date.now() - t2;
      const unionSurface: ApiSurface = {
        ...(prepared[0] as Prepared).installedSurface,
        symbols: prepared.flatMap((p) => p.installedSurface.symbols),
      };
      const changedPaths = new Set(
        [...diffs.values()].flatMap((d) => d.changes.map((c) => c.path)),
      );
      const merged = mergeSignals(allUsages, signal, unionSurface, changedPaths);
      compiled = signal.skipped === undefined;
      usages = merged.usages;
      // An inferred usage (from a message) belongs to whichever member declares the symbol.
      for (const u of usages) {
        if (u.package === undefined) {
          u.package = prepared.find((p) =>
            p.installedSurface.symbols.some((s) => s.path === u.symbolPath),
          )?.name;
        }
      }
      linkedDirs = signal.linkedDependencyDirs ?? {};
      compile = {
        baselineErrors: signal.baselineErrors,
        skipped: signal.skipped,
        unresolvedInTarget: signal.unresolvedInTarget,
        unresolvedFiles: signal.unresolvedFiles,
        unattributed: merged.unattributed,
        newErrors: signal.diagnostics.length,
        coverage: { ...signal.coverage, workspaces: 1 },
      };
      if (signal.skipped) notes.push(signal.skipped);
      else if (signal.baselineErrors > 0)
        notes.push(
          `${signal.baselineErrors} pre-existing type error${signal.baselineErrors === 1 ? '' : 's'} at the installed version (subtracted)`,
        );
      const fetchedDeps = signal.linkedDependencies.filter((l) => l.endsWith('(fetched)')).length;
      if (fetchedDeps > 0)
        notes.push(
          `${fetchedDeps} dependenc${fetchedDeps === 1 ? 'y' : 'ies'} of ${name}@${base('safe').target} fetched at the versions it declares`,
        );
      for (const u of signal.unsatisfiedDependencies)
        notes.push(`dependency of ${name} unsatisfied: ${u}`);
      if (signal.unresolvedInTarget.length > 0) {
        notes.push(
          `${signal.unresolvedInTarget.length} unresolved module${signal.unresolvedInTarget.length === 1 ? '' : 's'} inside ${name}, results may be incomplete`,
        );
      }
    }

    // Signal C runs once the compiler has linked the target's dependencies: the probe serves the
    // same directories, so a target needing newer dependencies than the consumer has loads too.
    // What the compiler did not link (runtime-only dependencies) is fetched on demand, from the
    // registry only, at the range the importer declares.
    const resolveDependency = async (dep: string, range: string): Promise<string | undefined> => {
      const wanted = range === '*' || /^[a-z]+:/i.test(range) ? '>=0.0.0' : range;
      // The consumer's own copy when it satisfies the range (what the upgrade would keep).
      const consumer = installedPackageDirOf(ctx.adapter, repo, dep, '');
      const consumerVersion = consumer ? readManifest(consumer.dir)?.version : undefined;
      if (
        consumer &&
        consumerVersion &&
        maxSatisfying([consumerVersion], wanted) === consumerVersion
      )
        return realpathSafe(consumer.dir);
      const versions = ctx.fetcher.versions ? await ctx.fetcher.versions(dep).catch(() => []) : [];
      const best = maxSatisfying(versions, wanted);
      if (best === undefined) return undefined;
      return (
        await progress(ctx.opts.onProgress, { phase: 'fetch', package: dep, workspace }, () =>
          ctx.fetcher.fetch(dep, best),
        )
      ).dir;
    };
    if (ctx.opts.runtime !== false) {
      outOfTime(ctx);
      const tRuntime = Date.now();
      for (const { p, pkg, runtime } of fetched) {
        const installedDir = (p.runtimeDir ?? p.installedDir).dir;
        p.runtime = await progress(
          ctx.opts.onProgress,
          { phase: 'runtime', package: p.name, workspace },
          () =>
            probeBoth(
              p.name,
              installedDir,
              runtime?.dir ?? pkg.dir,
              nodeRange,
              linkedDirs,
              resolveDependency,
            ),
        );
        p.runtime.usedKeys = [
          ...new Set(
            p.scan.usages.flatMap((u) =>
              usagePaths(u).flatMap((path) => path.split(/[.#[\]]/).filter(Boolean)),
            ),
          ),
        ];
      }
      timing.runtimeMs = Date.now() - tRuntime;
      const first = prepared.map((p) => p.runtime).find((r) => r !== undefined);
      if (first && first.nodeSource === 'current' && nodeRange !== undefined) {
        notes.push(
          `runtime probed with the current Node ${first.node}: no local install of Node ${nodeRange} (${node?.source}) was found${node?.caveat ? `; ${node.caveat}` : ''}`,
        );
      }
    }

    const findings: Finding[] = [];
    for (const p of prepared) {
      // Curated behaviour changes the declarations do not show (express 5 routing).
      const usageFiles = [...new Set(p.scan.usages.map((u) => u.file))];
      findings.push(
        ...runtimeChangeFindings(
          { package: p.name, from: p.installedVersion, to: p.target },
          usageFiles.flatMap((file) => {
            try {
              return [{ file, text: readFileSync(join(repo.dir, file), 'utf8') }];
            } catch {
              return [];
            }
          }),
        ),
      );
      const diff = diffs.get(p.name) as Awaited<ReturnType<typeof diffDirs>>;
      // Symbols declared in a target file with unresolved imports: the compiler's silence proves nothing there.
      const unverifiedPaths = new Set<string>();
      if (compile && compile.unresolvedFiles.length > 0) {
        const files = new Set(compile.unresolvedFiles);
        const fileOf = new Map<string, string | undefined>();
        for (const sym of diff.surfaceA.symbols) fileOf.set(sym.path, sym.file);
        for (const sym of diff.surfaceB.symbols) fileOf.set(sym.path, sym.file);
        for (const change of diff.changes) {
          const file = fileOf.get(change.path);
          if (file !== undefined && files.has(file)) unverifiedPaths.add(change.path);
        }
      }
      const own = usages.filter((u) => u.package === p.name);
      // What `require(esm)` of the target hands back by name: its top-level exports.
      const esmNamed = new Set(
        diff.surfaceB.symbols.map((sym) => sym.path).filter((path) => !/[.#[]/.test(path)),
      );
      findings.push(
        ...match(diff.changes, own, {
          compiled,
          unverifiedPaths,
          references: p.references,
          esmNamed,
          ...(p.runtime?.targetRequire ? { targetRequire: p.runtime.targetRequire } : {}),
          targetPaths: new Set(diff.surfaceB.symbols.map((sym) => sym.path)),
        }),
      );
    }
    if (!compiled && findings.some((f) => f.severity === 'breaking')) {
      notes.push('unverified: compile check skipped');
    }
    if (compile) {
      const explained = new Set(findings.map((f) => f.usage));
      const wentEsmOnly = new Set(
        findings.filter((f) => f.change.kind === 'module-format').map((f) => f.usage),
      );
      for (const u of usages) {
        if (u.compileError === undefined || explained.has(u)) continue;
        // A package that went ESM-only already explains its require() sites.
        if (wentEsmOnly.has(u)) continue;
        // `const x = require('pkg'); x()` rejected as "not callable" while the target still
        // ships a CommonJS build: the declarations moved from `export =` to a default export,
        // which the CommonJS build normally still assigns to module.exports. Types say no,
        // the runtime usually says yes: unverified, not breaking.
        const shapeCodes = new Set([2349, 2351, 2507]);
        if (
          u.loader === 'require' &&
          u.compileCode !== undefined &&
          shapeCodes.has(u.compileCode) &&
          (u.access === 'call' || u.access === 'construct')
        ) {
          findings.push({
            change: {
              package: name,
              from: (prepared[0] as Prepared).installedVersion,
              to: (prepared[0] as Prepared).target,
              path: `TS${u.compileCode}`,
              kind: 'type',
              severity: 'breaking',
              source: 'types',
              confidence: 0.6,
              evidence: 'checker',
              notes:
                'the declarations now export a default where the installed version used `export =`; the CommonJS build normally still assigns module.exports, so the require() value is usually callable at runtime',
            },
            usage: u,
            severity: 'unverified',
            confidence: 0.6,
            fixability: 'assisted',
            reason:
              'types reject calling the require() value (default export instead of `export =`); the CommonJS build usually keeps module.exports callable, verify at runtime or switch to import',
          });
          continue;
        }
        compile.unattributed.push({
          file: u.file,
          line: u.line,
          column: u.column,
          endLine: u.endLine,
          endColumn: u.endColumn,
          code: u.compileCode ?? 0,
          message: u.compileError,
          snippet: u.snippet,
        });
      }
      compile.unattributed.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
      // New in the overlay, absent from the baseline: a break by definition, named or not.
      const first = prepared[0] as Prepared;
      findings.push(
        ...unattributedFindings(
          compile.unattributed,
          { package: name, from: first.installedVersion, to: first.target },
          {
            ...first.installedSurface,
            symbols: [...diffs.values()].flatMap((d) => d.surfaceB.symbols),
          },
          compile.unresolvedFiles,
          workspace === '.' ? '' : `${workspace}/`,
        ),
      );
    }
    // An installed version without declarations: every compile error against the target exists only
    // because the target ships types. Real for a type-checked build, invisible to this repository
    // today: unverified, with the reason.
    if (prepared.every((p) => p.untyped)) {
      for (const f of findings) {
        if (f.severity !== 'breaking') continue;
        if (!/^TS\d+$/.test(f.change.path) && !f.change.path.startsWith('cause:')) continue;
        f.severity = 'unverified';
        f.reason = `${f.reason}; the installed version ships no declarations, so this error exists only because ${prepared[0]?.target} does`;
      }
    }
    // Files the repository does not type-check: the runtime probe is the arbiter there, not the
    // compiler. Usages the compiler inferred carry no flag yet; their file decides.
    const checksJs = prepared.some((p) => p.scan.checksJs);
    const heads = new Map<string, string>();
    const headOf = (file: string): string => {
      let head = heads.get(file);
      if (head === undefined) {
        try {
          head = readFileSync(join(repo.dir, file), 'utf8').slice(0, 2000);
        } catch {
          head = '';
        }
        heads.set(file, head);
      }
      return head;
    };
    for (const f of findings) {
      if (
        f.usage.checked === undefined &&
        !repoTypeChecks(f.usage.file, headOf(f.usage.file), checksJs)
      )
        f.usage.checked = false;
    }
    const runtimeOf = (f: Finding): Prepared | undefined =>
      prepared.find((p) => p.name === (f.usage.package ?? f.change.package)) ?? prepared[0];
    const arbitrated =
      prepared.length === 1
        ? arbitrateUnchecked(findings, prepared[0]?.runtime, loadRootOf(prepared[0] as Prepared))
        : findings.map((f) => {
            const p = runtimeOf(f);
            return arbitrateUnchecked([f], p?.runtime, p ? loadRootOf(p) : undefined)[0] as Finding;
          });
    findings.length = 0;
    findings.push(...arbitrated);
    // A pack can see what no type diff shows: a client the SDK bump reconfigures at runtime.
    const pack = packsOf(ctx.opts).find((candidate) => candidate.name === name);
    // The pack speaks for the package it covers: alone, or leading its companions.
    const only = leader ?? (prepared.length === 1 ? prepared[0] : undefined);
    const packDirs = (p: Prepared) => {
      const target = fetched.find((f) => f.p === p);
      return {
        installedDir: (p.runtimeDir ?? p.installedDir).dir,
        targetDir: target?.runtime?.dir ?? target?.pkg.dir ?? p.installedDir.dir,
      };
    };
    if (pack?.runtimeFindings && only) {
      try {
        findings.push(
          ...pack.runtimeFindings({
            root: ctx.opts.cwd,
            workspace,
            from: only.installedVersion,
            to: only.target,
            ...packDirs(only),
            usages: only.scan.usages,
            read: (file) => {
              try {
                return readFileSync(resolve(ctx.opts.cwd, file), 'utf8');
              } catch {
                return undefined;
              }
            },
          }),
        );
      } catch {
        // A pack that cannot read its versions adds nothing; the diff findings stand.
      }
    }
    // Breaking means confirmed, in every tier: a type-surface change the compiler, the runtime
    // probe or the pack did not confirm at the site is possible impact, never counted as breaking.
    const tier = tierOf(
      packsOf(ctx.opts),
      name,
      (leader?.installedVersion ?? installed[0]) as string,
      (leader?.target ?? targets.at(-1)) as string,
    );
    const evidence = (f: Finding): Finding['evidence'] => {
      const p = runtimeOf(f);
      return evidenceOf(f, p?.runtime, p ? loadRootOf(p) : undefined);
    };
    const confirmed = confirmBreaking(findings, evidence);
    findings.length = 0;
    findings.push(...confirmed);
    // An import the target no longer has: what it exports instead is what a person, or the
    // agent, needs to choose a replacement. Without a pack nothing else says it.
    if (tier === 'generic')
      for (const f of findings) {
        // A resource limit of the compiler, not a property of one expression: the upgrade
        // makes the types too deep, and where that is reported varies between compilers.
        if (f.severity === 'breaking' && [2589, 2590].includes(f.usage.compileCode ?? 0))
          f.details = [
            ...(f.details ?? []),
            'the compiler reaches its type-instantiation limit after the upgrade; which expression reports it depends on the compiler version, so yours may name another site',
          ];
        if (f.severity !== 'breaking' || ![2305, 2614, 2724].includes(f.usage.compileCode ?? 0))
          continue;
        const diff = diffs.get(f.usage.package ?? f.change.package) ?? [...diffs.values()][0];
        const exported = [
          ...new Set(
            (diff?.surfaceB.symbols ?? [])
              .map((sym) => sym.path)
              .filter((path) => !/[.#[(]/.test(path)),
          ),
        ].sort();
        if (exported.length > 0)
          f.details = [
            ...(f.details ?? []),
            `${f.change.package} ${f.change.to} exports: ${exported.slice(0, 60).join(', ')}${exported.length > 60 ? `, and ${exported.length - 60} more` : ''}`,
          ];
      }
    const unanalyzedCount = prepared.reduce((n, p) => n + p.scan.unanalyzed.length, 0);
    let status = statusOf(findings, usages.length, unanalyzedCount);
    // Nothing to diff and nothing found: the honest status is "no types", with the reason in the notes.
    if (prepared.every((p) => p.untyped) && status !== 'breaking' && status !== 'deprecated')
      status = 'no-types';
    const report = base(status);
    report.tier = tier;
    const viaTypes = prepared.filter((p) => p.types);
    if (viaTypes.length > 0) {
      report.typesVia = viaTypes
        .map(
          (p) =>
            `${p.types?.name} ${p.types?.baseline ?? p.types?.installedVersion} → ${p.types?.target}`,
        )
        .join(', ');
    }
    report.findings = findings;
    report.callSitesChecked = usages.length;
    if (compile) report.compile = compile;
    // Analyzed packages only: a skipped or untyped one says why in its status.
    if (['breaking', 'deprecated', 'safe', 'partial', 'unknown'].includes(report.status))
      report.verdict = verdictOf(
        report,
        ctx.opts.compile === false
          ? 'compile check off (--no-compile)'
          : sameDeclarations
            ? 'type declarations unchanged'
            : 'this language adapter does not compile',
      );
    const runtime = prepared.map((p) => p.runtime).filter((r) => r !== undefined);
    if (runtime.length > 0) report.runtime = runtime;
    // A pack's plan note is fed from what this workspace already has: both copies and the usages.
    if (pack?.planContext && only && ctx.opts.plan !== false) {
      try {
        report.planContext = pack.planContext({
          root: ctx.opts.cwd,
          workspace,
          ...packDirs(only),
          usages: only.scan.usages,
        });
        // Evidence where the compiler rejected the code is confirmed: the change is real there.
        const rejected = new Set(
          findings
            .filter((f) => f.usage.compileError !== undefined)
            .map((f) => `${join(workspace, f.usage.file)}:${f.usage.line}`),
        );
        if (report.planContext.evidence)
          report.planContext.evidence = report.planContext.evidence.map((e) =>
            rejected.has(`${e.file}:${e.line}`) ? { ...e, compiler: true } : e,
          );
      } catch {
        // No note is better than a failed check.
      }
    }
    return report;
  } catch (err) {
    if (err instanceof NoTypesError) {
      const side = fetched.some(({ pkg }) => !shipsTypes(pkg.dir)) ? 'target' : 'installed version';
      notes.push(
        `${err.packageName}@${err.version}: no type declarations in the ${side}, cannot diff`,
      );
      return { ...base('no-types'), skipReason: 'NO_TYPES' };
    }
    throw err;
  }
}

/**
 * Signal C for one member: both copies loaded by the same Node with the consumer's own
 * dependencies, so a target that needs something the repository does not have is reported as
 * inconclusive rather than as broken.
 */
async function probeBoth(
  name: string,
  installedDir: string,
  targetDir: string,
  nodeRange: string | undefined,
  targetLinks: Record<string, string>,
  resolveDependency: (dep: string, range: string) => Promise<string | undefined>,
): Promise<RuntimeReport> {
  // The real directory: under pnpm the consumer's entry is a symlink into `.pnpm`, and the
  // package's own dependencies live next to the real copy, not next to the symlink.
  const real = realpathSafe(installedDir);
  const dependenciesFrom = nodeModulesOf(real);
  const options = nodeRange === undefined ? { dependenciesFrom } : { dependenciesFrom, nodeRange };
  const before = await probeRuntime(real, options);
  const after = await probeRuntime(targetDir, {
    ...options,
    extraLinks: targetLinks,
    resolveDependency,
    linkConsumer: false,
  });
  const diff = diffRuntime(before, after);
  const report: RuntimeReport = {
    package: name,
    node: after.node,
    nodeSource: after.nodeSource,
    changes: diff.changes,
  };
  if (diff.inconclusive) report.inconclusive = diff.inconclusive;
  else if (after.nodeSource === 'repository') report.targetRequire = after.require;
  return report;
}

function realpathSafe(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

/** The `node_modules` an installed copy lives in: with pnpm, the one next to its real path, which holds its own dependencies. */
function nodeModulesOf(installedDir: string): string {
  const marker = `${sep}node_modules${sep}`;
  const at = installedDir.lastIndexOf(marker);
  return at < 0 ? join(installedDir, '..') : installedDir.slice(0, at + marker.length - 1);
}

/** The path the module value itself answers to: the `export =` symbol, else `default`. */
function loadRootOf(p: Prepared): string {
  return p.installedSurface.symbols.find((s) => s.exportEquals)?.path ?? 'default';
}

/** Members that all left the group early (up to date, unused): one report carrying their notes. */
function mergeEarly(workspace: string, early: PackageReport[]): PackageReport {
  const first = early[0] as PackageReport;
  return {
    ...first,
    workspace,
    name: groupName(early.map((p) => p.name)),
    members: early.map((p) => ({ name: p.name, installed: p.installed, target: p.target })),
    ...(early.find((p) => p.skipReason)?.skipReason
      ? { skipReason: early.find((p) => p.skipReason)?.skipReason }
      : {}),
    notes: early.flatMap((p) => p.notes.map((n) => `${p.name}: ${n}`)),
    status: early.every((p) => p.status === first.status) ? first.status : 'safe',
  };
}

function installedPackageDirOf(
  adapter: LanguageAdapter,
  repo: RepoDir,
  name: string,
  version: string,
): PackageDir | undefined {
  const locate = (
    adapter as { installedPackageDir?: (repo: RepoDir, pkg: string) => string | undefined }
  ).installedPackageDir;
  const dir = locate?.(repo, name);
  return dir ? { name, version, dir } : undefined;
}
