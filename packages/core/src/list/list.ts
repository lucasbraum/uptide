import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { typescriptAdapter } from '../adapters/typescript/index.js';
import { mapWithLimit } from '../check/pool.js';
import { tierOf } from '../check/tier.js';
import { compareVersions, parseVersion } from '../check/version.js';
import type { LanguageAdapter } from '../domain/adapter.js';
import type { PackageFetcher } from '../domain/io.js';
import type { Tier } from '../domain/report.js';
import { errorCode } from '../errors.js';
import { loadRegistryConfig, registryFor } from '../fetch/npmrc.js';
import { advisoriesEnabled } from '../llm/config.js';
import { activePacks } from '../packs/index.js';
import type { TaskCommands } from './config.js';
import {
  BUILD_TOOLS,
  installedManifest,
  knownTool,
  type Manifest,
  toolingReasons,
  UNUSED_REASON,
} from './evidence.js';
import { dependencyGroups, peerBlocks } from './groups.js';
import {
  type Advisory,
  deprecatedSignal,
  effortOf,
  type PackageSignals,
  type Priority,
  prioritize,
  securitySignal,
  unsupportedSignal,
} from './priorities.js';
import {
  createDiscoveryFetcher,
  DiscoveryRegistryError,
  type RegistrySignals,
  registryFailure,
  registryHost,
} from './registry.js';
import { type ScanStats, scanImports } from './scan.js';
import { catalogSpec, dependencySource } from './spec.js';

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export interface ListedDependency {
  name: string;
  /** The real registry name when the manifest uses an npm alias. */
  registryName?: string;
  /** The oldest outdated installed version: `change`, `majorGap` and `tier` describe it. */
  current: string;
  /**
   * Every installed version, oldest first, when workspaces declare more than one (outdated
   * or not). One row per package either way.
   */
  versions?: { version: string; workspaces: string[] }[];
  latest: string;
  change: 'major' | 'minor' | 'patch';
  tier: Tier;
  majorGap: number;
  classification: 'used' | 'tooling' | 'possibly-unused' | 'peer';
  /**
   * runtime: declared in dependencies or optionalDependencies (or a peer of a package that
   * is), and not tooling; dev: only in devDependencies, or tooling. Dev ranks after runtime.
   */
  kind?: 'runtime' | 'dev';
  peerOf?: string[];
  reasons: string[];
  /** What makes it worth upgrading first; see priorities.ts. */
  signals?: PackageSignals;
  /** Workspaces on an outdated version. */
  workspaces: string[];
  usage: {
    files: number;
    callSites: number;
    references: number;
    fileList?: string[];
    topSymbols: { name: string; count: number }[];
    workspaces: string[];
  };
}
export interface ListGroup {
  id: string;
  lead?: string;
  name: string;
  /** Why the members upgrade together: `@radix-ui family`, `peer link`, `shared <dependency>`. */
  reason?: string;
  members: ListedDependency[];
}
export interface ListReport {
  repo: string;
  workspaces: string[];
  packages: ListedDependency[];
  groups: ListGroup[];
  /** Most urgent first. Empty when nothing is urgent. */
  priorities?: Priority[];
  /** Minor and patch upgrades touching few files, with no urgent signal: one PR's worth. */
  cheapBatch?: string[];
  /** Whether known advisories were looked up; `not checked` never fails the run. */
  advisories?: { status: 'checked' | 'not checked'; packages: number; reason?: string };
  scanWarnings?: string[];
  /** Packages whose latest version could not be checked; never counted as up to date. */
  unknown?: { name: string; currentVersions: string[]; workspaces: string[]; reason: string }[];
  /** Intentional skips, separate from incomplete discovery and network unknowns. */
  skipped?: { name: string; source: string; reason: string; workspaces: string[] }[];
  failures: {
    name: string;
    workspace?: string;
    reason: string;
    kind?: 'registry';
    host?: string;
    summary?: string;
    status?: number;
  }[];
  timing: {
    totalMs: number;
    phases?: {
      manifestReadMs: number;
      registryMs: number;
      sourceScanMs: number;
      configScanMs: number;
    };
    files?: {
      manifests: number;
      installedManifests: number;
      visited: number;
      source: number;
      config: number;
      assets: number;
      candidateSources?: number;
      ignoredSources?: number;
      ignoredSourceRules?: Record<string, number>;
      parsed?: number;
      workers?: number;
      skipped?: ScanStats['skipped'];
    };
  };
}
export interface ListOptions {
  cwd: string;
  only?: string[];
  adapter?: LanguageAdapter;
  fetcher?: Pick<PackageFetcher, 'resolve' | 'metadata'> & Partial<RegistrySignals>;
  details?: boolean;
  verbose?: boolean;
  /** "Now" for the support window; tests pin it. */
  now?: Date;
  /**
   * `false` (`--no-advisories`): installed versions are never sent to npm's advisory endpoint.
   * Unset: on, unless uptide.config.json says `"advisories": false`.
   */
  advisories?: boolean;
}

/** Discovery only. Reads manifests, lockfiles, source syntax and registry metadata. */
export async function listDependencies(opts: ListOptions): Promise<ListReport> {
  const start = Date.now();
  const manifestStart = performance.now();
  const adapter = opts.adapter ?? typescriptAdapter;
  const config = loadRegistryConfig({ cwd: opts.cwd });
  const fetcher = opts.fetcher ?? createDiscoveryFetcher({ cwd: opts.cwd, config });
  const workspaces = ((await adapter.workspacePackages?.({ dir: opts.cwd })) ?? ['.']).sort();
  const workspaceNames = new Set(
    workspaces
      .map(
        (w) =>
          (JSON.parse(readFileSync(join(opts.cwd, w, 'package.json'), 'utf8')) as { name?: string })
            .name,
      )
      .filter(Boolean),
  );
  const failures: ListReport['failures'] = [];
  const blocked = new Set<string>();
  const identities = new Map<string, { name: string; registryName: string }>();
  const localName = (key: string): string => identities.get(key)?.name ?? key;
  const registryName = (key: string): string => identities.get(key)?.registryName ?? key;
  const fail = (name: string, error: unknown, context = ''): void => {
    const code = errorCode(error);
    const registry =
      error instanceof DiscoveryRegistryError ||
      code.startsWith('REGISTRY_') ||
      code === 'PACKAGE_NOT_FOUND' ||
      code === 'VERSION_NOT_FOUND';
    if (code === 'REGISTRY_AUTH' || code === 'REGISTRY_UNREACHABLE') blocked.add(name);
    failures.push({
      name: localName(name),
      ...(registry ? { kind: 'registry' as const } : {}),
      ...(error instanceof DiscoveryRegistryError
        ? {
            host: error.host,
            summary: error.summary,
            ...(error.status ? { status: error.status } : {}),
          }
        : {}),
      reason: registry
        ? registryFailure(error, registryHost(registryFor(registryName(name), config)))
        : `${context}${error instanceof Error ? error.message : String(error)}`,
    });
  };
  const manifests: Manifest[] = [];
  // Keep workspace aliases with different targets separate, even at identical versions.
  const declared = new Map<string, Map<string, string[]>>();
  const skipped = new Map<string, NonNullable<ListReport['skipped']>[number]>();
  // Declared as a runtime dependency in some workspace: dependencies or optionalDependencies.
  const runtimeKeys = new Set<string>();
  const skip = (name: string, source: string, workspace: string): void => {
    if (opts.only && !opts.only.includes(localName(name))) return;
    const key = JSON.stringify([name, source]);
    const item = skipped.get(key) ?? {
      name,
      source,
      reason: `not checked: non-registry source (${source})`,
      workspaces: [],
    };
    if (!item.workspaces.includes(workspace)) item.workspaces.push(workspace);
    skipped.set(key, item);
  };
  for (const workspace of workspaces) {
    const dir = resolve(opts.cwd, workspace);
    const installed =
      (await adapter.installedDependencies?.({ dir }).catch((error: unknown) => {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'NO_LOCKFILE')
          return new Map<string, string>();
        throw error;
      })) ?? new Map<string, string>();
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Manifest;
    manifests.push(manifest);
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies'] as const) {
      const value = manifest[field];
      if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value)))
        throw new Error(`malformed package.json: ${field} must be an object`);
    }
    const runtimeNames = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
    ]);
    for (const [name, spec] of Object.entries({
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.optionalDependencies,
    })) {
      const source = dependencySource(name, catalogSpec(dir, name, spec));
      if (source.kind === 'invalid') {
        failures.push({
          name,
          workspace,
          reason: 'malformed dependency declaration in package.json',
        });
        continue;
      }
      if (source.kind === 'non-registry') {
        skip(name, source.source, workspace);
        continue;
      }
      if (workspaceNames.has(name) && source.name === name && !spec.trim().startsWith('npm:')) {
        skip(name, 'workspace', workspace);
        continue;
      }
      const locked = installed.get(name);
      // pnpm aliases encode their actual package name in the locked version.
      const lockedAlias = locked && /^(?:npm:)?(?:@[\w.-]+\/)?[\w.-]+@(.+)$/.exec(locked);
      const version =
        lockedAlias?.[1] ??
        locked ??
        (/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(source.range) ? source.range : undefined);
      if (!version || !parseVersion(version)) {
        failures.push({
          name,
          workspace,
          reason:
            'no locked or exact current version; install dependencies to resolve the declared range',
        });
        continue;
      }
      const key = JSON.stringify([name, source.name]);
      identities.set(key, { name, registryName: source.name });
      if (runtimeNames.has(name)) runtimeKeys.add(key);
      const versions = declared.get(key) ?? new Map<string, string[]>();
      versions.set(version, [...(versions.get(version) ?? []), workspace]);
      declared.set(key, versions);
    }
  }
  let manifestReadMs = performance.now() - manifestStart;
  const names = [...declared.keys()].sort();
  const configs: string[] = [];
  const fileEvidence = new Map<string, string[]>();
  const scanStats: ScanStats = {
    sourceMs: 0,
    configMs: 0,
    visitedFiles: 0,
    sourceFiles: 0,
    configFiles: 0,
    assetFiles: 0,
  };
  const tasks: TaskCommands[] = [];
  const usage = await scanImports(
    opts.cwd,
    [...new Set(names.map(localName))],
    workspaces,
    configs,
    fileEvidence,
    scanStats,
    tasks,
  );
  const scripts = manifests.flatMap((m) => Object.values(m.scripts ?? {})).join('\n');
  const metadata = new Map<string, Manifest[]>();
  const targets = new Map<string, Manifest>();
  const latestVersions = new Map<string, string>();
  const missingVersions = new Map<string, string[]>();
  const installedStart = performance.now();
  let installedManifests = 0;
  for (const name of names) {
    const items: Manifest[] = [];
    const missing: string[] = [];
    for (const [version, locations] of declared.get(name) ?? []) {
      const local = locations
        .map((w) => installedManifest(opts.cwd, w, localName(name)))
        .filter((m): m is Manifest => !!m && (!m.version || m.version === version));
      installedManifests += local.length;
      if (local.length) items.push(...local);
      else missing.push(version);
    }
    metadata.set(name, items);
    missingVersions.set(name, missing);
  }
  manifestReadMs += performance.now() - installedStart;
  /** Deprecation and versions come from the packument already fetched; publish dates only
   * for a package with a newer major, where the support window matters. Never fatal. */
  const collectSignals = async (name: string, latest: string): Promise<void> => {
    const outdated = [...(declared.get(name)?.keys() ?? [])].filter(
      (current) => compareVersions(latest, current) > 0,
    );
    if (!outdated.length) return;
    const real = registryName(name);
    await Promise.all([
      ...outdated.map(async (current) => {
        const message = await fetcher.deprecation?.(real, current).catch(() => undefined);
        if (message) deprecations.set(JSON.stringify([name, current]), message);
      }),
      fetcher
        .versions?.(real)
        .then((list) => allVersions.set(name, list))
        .catch(() => {}),
      outdated.some((c) => (parseVersion(latest)?.major ?? 0) > (parseVersion(c)?.major ?? 0)) &&
      fetcher.published
        ? fetcher
            .published(real)
            .then((time) => published.set(name, time))
            .catch(() => {})
        : undefined,
    ]);
  };
  const registryStart = performance.now();
  const wanted = names.filter((name) => !opts.only || opts.only.includes(localName(name)));
  // One bulk request for every installed version, alongside the version lookups.
  const advisoryQuery = new Map<string, string[]>();
  for (const name of wanted)
    advisoryQuery.set(registryName(name), [
      ...new Set([
        ...(advisoryQuery.get(registryName(name)) ?? []),
        ...(declared.get(name)?.keys() ?? []),
      ]),
    ]);
  const advisoriesOff =
    opts.advisories === false
      ? 'turned off with --no-advisories'
      : opts.advisories === undefined && !advisoriesEnabled(opts.cwd)
        ? 'turned off in uptide.config.json'
        : undefined;
  const advisoryRequest: Promise<
    { checked: string[]; advisories: Record<string, Advisory[]> } | { error: string }
  > = advisoriesOff
    ? Promise.resolve({ error: advisoriesOff })
    : fetcher.advisories
      ? fetcher.advisories(advisoryQuery).catch((error: unknown) => ({
          error:
            error instanceof Error && error.name === 'TimeoutError'
              ? 'timed out'
              : 'request failed',
        }))
      : Promise.resolve({ error: 'not available for this registry client' });
  const deprecations = new Map<string, string>();
  const published = new Map<string, Record<string, string>>();
  const allVersions = new Map<string, string[]>();
  await mapWithLimit(names, 16, async (name) => {
    const items = metadata.get(name) as Manifest[];
    // Resolve each package independently within the bounded request pool.
    if (!opts.only || opts.only.includes(localName(name))) {
      try {
        const latest = await fetcher.resolve(registryName(name), 'latest');
        latestVersions.set(name, latest);
        if (
          fetcher.metadata &&
          [...(declared.get(name)?.keys() ?? [])].some(
            (current) => compareVersions(latest, current) > 0,
          )
        ) {
          try {
            targets.set(name, await fetcher.metadata(registryName(name), latest));
          } catch (error) {
            fail(name, error, 'target peer metadata unavailable: ');
          }
        }
        await collectSignals(name, latest);
      } catch (error) {
        fail(name, error);
        blocked.add(name);
      }
    }
    for (const version of missingVersions.get(name) ?? []) {
      if (!fetcher.metadata || blocked.has(name)) break;
      try {
        items.push({
          ...(await fetcher.metadata(registryName(name), version)),
          name: registryName(name),
        });
      } catch (error) {
        fail(name, error, 'tooling/peer metadata unavailable: ');
      }
    }
  });
  const advisoryResult = await advisoryRequest;
  const registryMs = performance.now() - registryStart;
  const configStart = performance.now();
  const configText = configs.join('\n');
  const reasons = new Map(
    names.map((name) => [
      name,
      [
        ...toolingReasons(
          localName(name),
          metadata.get(name) ?? [],
          scripts,
          configText,
          manifests,
          tasks,
        ),
        ...(!knownTool(localName(name)) && knownTool(registryName(name))
          ? ['known configuration or build tool']
          : []),
        ...(fileEvidence.get(localName(name)) ?? []),
      ],
    ]),
  );
  // Runtime/peer dependencies of used direct packages are required, even without imports.
  // Iterate the growing set to include chains/cycles; never follow devDependencies.
  const needed = new Set(
    names.filter((name) => usage.has(localName(name)) || (reasons.get(name)?.length ?? 0) > 0),
  );
  for (const name of needed) {
    for (const m of metadata.get(name) ?? []) {
      for (const peer of new Set([
        ...Object.keys(m.dependencies ?? {}),
        ...Object.keys(m.peerDependencies ?? {}),
      ])) {
        for (const key of names.filter((key) => localName(key) === peer)) {
          const evidence = reasons.get(key) as string[];
          const reason = `required by ${localName(name)}`;
          if (!evidence.includes(reason)) evidence.push(reason);
          const peerReason = `peer dependency of ${localName(name)}`;
          if (m.peerDependencies?.[peer] && !evidence.includes(peerReason))
            evidence.push(peerReason);
          needed.add(key);
        }
      }
    }
  }
  for (const name of names.filter((n) => localName(n).startsWith('@types/'))) {
    const runtime = localName(name)
      .slice('@types/'.length)
      .replace(/^([^_]+)__/, '@$1/');
    if (runtime === 'node' || [...needed].some((key) => localName(key) === runtime))
      (reasons.get(name) as string[]).push(`types for ${runtime}`);
  }
  const packages = names
    .filter((name) => !opts.only || opts.only.includes(localName(name)))
    .flatMap((name): ListedDependency[] => {
      const latest = latestVersions.get(name);
      if (!latest) return [];
      // One row per package: workspaces on different versions are one upgrade, and usage
      // is counted once across the repo.
      const all = [...(declared.get(name) ?? [])].sort(([a], [b]) => compareVersions(a, b));
      const outdated = all.filter(([version]) => compareVersions(latest, version) > 0);
      if (!outdated.length) return [];
      const [current] = outdated[0] as [string, string[]];
      const from = parseVersion(current) ?? { major: 0, minor: 0, patch: 0 };
      const to = parseVersion(latest) ?? { major: 0, minor: 0, patch: 0 };
      const scanned = usage.get(localName(name));
      return [
        {
          name: localName(name),
          ...(registryName(name) !== localName(name) ? { registryName: registryName(name) } : {}),
          current,
          ...(all.length > 1
            ? { versions: all.map(([version, workspaces]) => ({ version, workspaces })) }
            : {}),
          latest,
          change: to.major > from.major ? 'major' : to.minor > from.minor ? 'minor' : 'patch',
          majorGap: Math.max(0, to.major - from.major),
          // A compiler or bundler is tooling even when a script imports it.
          classification:
            scanned?.files.length && !BUILD_TOOLS[localName(name)]
              ? 'used'
              : reasons.get(name)?.length
                ? 'tooling'
                : 'possibly-unused',
          reasons:
            !scanned?.files.length && !reasons.get(name)?.length
              ? [
                  UNUSED_REASON,
                  ...(failures.some((f) => f.name === localName(name))
                    ? ['tooling/peer metadata incomplete; install dependencies and scan again']
                    : []),
                ]
              : (reasons.get(name) ?? []),
          tier: tierOf(activePacks(), localName(name), current, latest),
          workspaces: [...new Set(outdated.flatMap(([, w]) => w))].sort(),
          usage: {
            files: scanned?.files.length ?? 0,
            callSites: scanned?.callSites ?? 0,
            references: scanned?.references ?? 0,
            ...(opts.details ? { fileList: scanned?.files ?? [] } : {}),
            workspaces: scanned?.workspaces.sort() ?? [],
            topSymbols: Object.entries(scanned?.symbols ?? {})
              .filter(([, count]) => count > 0)
              .sort(([a, ac], [b, bc]) => bc - ac || compareText(a, b))
              .slice(0, 5)
              .map(([name, count]) => ({ name, count })),
          },
        },
      ];
    });
  packages.sort(
    (a, b) =>
      Number(b.change === 'major') - Number(a.change === 'major') ||
      b.usage.files - a.usage.files ||
      b.usage.callSites - a.usage.callSites ||
      compareText(a.name, b.name) ||
      compareVersions(a.current, b.current),
  );
  failures.sort(
    (a, b) => compareText(a.name, b.name) || compareText(a.workspace ?? '', b.workspace ?? ''),
  );
  // Group only unambiguous local identities; two workspaces may alias the same name
  // to unrelated packages, which is not evidence that their upgrades move together.
  const unambiguous = names.filter(
    (key) => names.filter((other) => localName(other) === localName(key)).length === 1,
  );
  const groups = dependencyGroups(
    packages.filter((p) => unambiguous.some((key) => localName(key) === p.name)),
    new Map(unambiguous.map((key) => [localName(key), metadata.get(key) ?? []])),
    new Map(
      unambiguous
        .filter((key) => targets.has(key))
        .map((key) => [localName(key), targets.get(key) as Manifest]),
    ),
  );
  // Signals, then priorities: what to upgrade first and why.
  const keyOf = new Map(names.map((key) => [localName(key), key]));
  const advisories = 'error' in advisoryResult ? {} : advisoryResult.advisories;
  const blocks = peerBlocks(
    packages,
    new Map(unambiguous.map((key) => [localName(key), metadata.get(key) ?? []])),
  );
  const now = opts.now ?? new Date();
  for (const p of packages) {
    const key = keyOf.get(p.name) ?? p.name;
    const together = groups.find(
      (g) => g.reason && !g.reason.endsWith(' family') && g.members.includes(p),
    );
    const installed = p.versions?.map((v) => v.version) ?? [p.current];
    const outdated = installed.filter((v) => compareVersions(p.latest, v) > 0);
    const security = securitySignal(
      outdated,
      advisories[p.registryName ?? p.name] ?? [],
      allVersions.get(key) ?? [],
    );
    const deprecated = deprecatedSignal(
      outdated.map((v) => deprecations.get(JSON.stringify([key, v]))).find(Boolean),
    );
    const majors = [...new Set(installed.map((v) => parseVersion(v)?.major ?? 0))];
    const time = published.get(key);
    const unsupported = time ? unsupportedSignal(p.current, p.latest, time, now) : undefined;
    p.kind =
      (runtimeKeys.has(key) || p.classification === 'peer') && p.classification !== 'tooling'
        ? 'runtime'
        : 'dev';
    p.signals = {
      ...(security ? { security } : {}),
      ...(deprecated ? { deprecated } : {}),
      ...(unsupported ? { unsupported } : {}),
      ...(majors.length > 1
        ? {
            drift: {
              majors,
              workspaces: new Set(p.versions?.flatMap((v) => v.workspaces)).size,
            },
          }
        : {}),
      ...(blocks.get(p.name)?.length ? { blocks: blocks.get(p.name) } : {}),
      ...(together
        ? {
            movesWith: [
              ...new Set(together.members.filter((m) => m.name !== p.name).map((m) => m.name)),
            ],
          }
        : {}),
      behind: p.majorGap,
      effort: effortOf(p.usage, p.tier === 'verified'),
      ...(p.kind === 'dev' ? { dev: true } : {}),
    };
  }
  const { priorities, cheapBatch } = prioritize(packages, groups);
  const failuresByName = new Map(failures.map((failure) => [failure.name, failure]));
  const unknown = new Map<string, NonNullable<ListReport['unknown']>[number]>();
  for (const key of names) {
    const name = localName(key);
    if ((opts.only && !opts.only.includes(name)) || latestVersions.has(key)) continue;
    const previous = unknown.get(name);
    unknown.set(name, {
      name,
      currentVersions: [
        ...new Set([...(previous?.currentVersions ?? []), ...(declared.get(key)?.keys() ?? [])]),
      ],
      workspaces: [
        ...new Set([
          ...(previous?.workspaces ?? []),
          ...[...(declared.get(key)?.values() ?? [])].flat(),
        ]),
      ],
      reason: failuresByName.get(name)?.reason ?? 'latest version unavailable',
    });
  }
  return {
    repo: opts.cwd,
    workspaces,
    packages,
    groups,
    priorities,
    cheapBatch,
    advisories:
      'error' in advisoryResult
        ? { status: 'not checked', packages: 0, reason: advisoryResult.error }
        : advisoryResult.checked.length
          ? { status: 'checked', packages: advisoryResult.checked.length }
          : {
              status: 'not checked',
              packages: 0,
              reason: 'every package comes from a private registry',
            },
    ...(scanStats.warnings?.length ? { scanWarnings: scanStats.warnings } : {}),
    skipped: [...skipped.values()].sort(
      (a, b) => compareText(a.name, b.name) || compareText(a.source, b.source),
    ),
    unknown: [...unknown.values()],
    failures: [...failuresByName.values()],
    timing: {
      totalMs: Date.now() - start,
      ...(opts.verbose
        ? {
            phases: {
              manifestReadMs,
              registryMs,
              sourceScanMs: scanStats.sourceMs,
              configScanMs: scanStats.configMs + performance.now() - configStart,
            },
            files: {
              manifests: workspaces.length,
              installedManifests,
              visited: scanStats.visitedFiles,
              source: scanStats.sourceFiles,
              config: scanStats.configFiles,
              assets: scanStats.assetFiles,
              candidateSources: scanStats.candidateSourceFiles,
              ignoredSources: scanStats.ignoredSourceFiles,
              ignoredSourceRules: scanStats.ignoredSourceRules,
              parsed: scanStats.parsedFiles,
              workers: scanStats.workers,
              skipped: scanStats.skipped,
            },
          }
        : {}),
    },
  };
}
