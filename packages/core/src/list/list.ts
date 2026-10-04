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
import { stripePack } from '../packs/stripe/index.js';
import { zodPack } from '../packs/zod/index.js';
import { installedManifest, type Manifest, toolingReasons, UNUSED_REASON } from './evidence.js';
import { dependencyGroups } from './groups.js';
import {
  createDiscoveryFetcher,
  DiscoveryRegistryError,
  registryFailure,
  registryHost,
} from './registry.js';
import { scanImports } from './scan.js';

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export interface ListedDependency {
  name: string;
  current: string;
  latest: string;
  change: 'major' | 'minor' | 'patch';
  tier: Tier;
  majorGap: number;
  classification: 'used' | 'tooling' | 'possibly-unused' | 'peer';
  peerOf?: string[];
  reasons: string[];
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
  name: string;
  members: ListedDependency[];
}
export interface ListReport {
  repo: string;
  workspaces: string[];
  packages: ListedDependency[];
  groups: ListGroup[];
  /** Packages whose latest version could not be checked; never counted as up to date. */
  unknown?: { name: string; currentVersions: string[]; workspaces: string[]; reason: string }[];
  failures: {
    name: string;
    workspace?: string;
    reason: string;
    kind?: 'registry';
    host?: string;
    summary?: string;
    status?: number;
  }[];
  timing: { totalMs: number };
}
export interface ListOptions {
  cwd: string;
  only?: string[];
  adapter?: LanguageAdapter;
  fetcher?: Pick<PackageFetcher, 'resolve' | 'metadata'>;
  details?: boolean;
}

/** Discovery only. Reads manifests, lockfiles, source syntax and registry metadata. */
export async function listDependencies(opts: ListOptions): Promise<ListReport> {
  const start = Date.now();
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
  const fail = (name: string, error: unknown, context = ''): void => {
    const code = errorCode(error);
    const registry =
      error instanceof DiscoveryRegistryError ||
      code.startsWith('REGISTRY_') ||
      code === 'PACKAGE_NOT_FOUND' ||
      code === 'VERSION_NOT_FOUND';
    if (code === 'REGISTRY_AUTH' || code === 'REGISTRY_UNREACHABLE') blocked.add(name);
    failures.push({
      name,
      ...(registry ? { kind: 'registry' as const } : {}),
      ...(error instanceof DiscoveryRegistryError
        ? {
            host: error.host,
            summary: error.summary,
            ...(error.status ? { status: error.status } : {}),
          }
        : {}),
      reason: registry
        ? registryFailure(error, registryHost(registryFor(name, config)))
        : `${context}${error instanceof Error ? error.message : String(error)}`,
    });
  };
  const manifests: Manifest[] = [];
  const declared = new Map<string, Map<string, string[]>>();
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
    for (const [name, spec] of Object.entries({
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.optionalDependencies,
    })) {
      if (workspaceNames.has(name)) continue;
      if (/^(workspace|link|file|git|https?):/.test(spec)) continue;
      const version =
        installed.get(name) ?? (/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(spec) ? spec : undefined);
      if (version && /^(workspace|link|file):/.test(version)) continue;
      if (!version || !parseVersion(version)) {
        failures.push({
          name,
          workspace,
          reason:
            'no locked or exact current version; install dependencies to resolve the declared range',
        });
        continue;
      }
      const versions = declared.get(name) ?? new Map<string, string[]>();
      versions.set(version, [...(versions.get(version) ?? []), workspace]);
      declared.set(name, versions);
    }
  }
  const names = [...declared.keys()].sort();
  const configs: string[] = [];
  const fileEvidence = new Map<string, string[]>();
  const usage = scanImports(opts.cwd, names, workspaces, configs, fileEvidence);
  const scripts = manifests.flatMap((m) => Object.values(m.scripts ?? {})).join('\n');
  const metadata = new Map<string, Manifest[]>();
  const targets = new Map<string, Manifest>();
  const latestVersions = new Map<string, string>();
  await mapWithLimit(names, 16, async (name) => {
    const items: Manifest[] = [];
    const missing: string[] = [];
    for (const [version, locations] of declared.get(name) ?? []) {
      const local = locations
        .map((w) => installedManifest(opts.cwd, w, name))
        .filter((m): m is Manifest => !!m && (!m.version || m.version === version));
      if (local.length) items.push(...local);
      else missing.push(version);
    }
    metadata.set(name, items);
    // Resolve each package independently within the bounded request pool.
    if (!opts.only || opts.only.includes(name)) {
      try {
        const latest = await fetcher.resolve(name, 'latest');
        latestVersions.set(name, latest);
        if (
          fetcher.metadata &&
          [...(declared.get(name)?.keys() ?? [])].some(
            (current) => compareVersions(latest, current) > 0,
          )
        ) {
          try {
            targets.set(name, await fetcher.metadata(name, latest));
          } catch (error) {
            fail(name, error, 'target peer metadata unavailable: ');
          }
        }
      } catch (error) {
        fail(name, error);
        blocked.add(name);
      }
    }
    for (const version of missing) {
      if (!fetcher.metadata || blocked.has(name)) break;
      try {
        items.push(await fetcher.metadata(name, version));
      } catch (error) {
        fail(name, error, 'tooling/peer metadata unavailable: ');
      }
    }
  });
  const configText = configs.join('\n');
  const reasons = new Map(
    names.map((name) => [
      name,
      [
        ...toolingReasons(name, metadata.get(name) ?? [], scripts, configText, manifests),
        ...(fileEvidence.get(name) ?? []),
      ],
    ]),
  );
  // Peers of used packages (including up-to-date ones) are required without source imports.
  const needed = new Set(
    names.filter((name) => usage.has(name) || (reasons.get(name)?.length ?? 0) > 0),
  );
  for (const name of needed) {
    for (const m of metadata.get(name) ?? []) {
      for (const peer of Object.keys(m.peerDependencies ?? {})) {
        if (!declared.has(peer)) continue;
        const evidence = reasons.get(peer) as string[];
        const reason = `peer dependency of ${name}`;
        if (!evidence.includes(reason)) evidence.push(reason);
        needed.add(peer);
      }
    }
  }
  for (const name of names.filter((n) => n.startsWith('@types/'))) {
    const runtime = name.slice('@types/'.length).replace(/^([^_]+)__/, '@$1/');
    if (runtime === 'node' || needed.has(runtime))
      (reasons.get(name) as string[]).push(`types for ${runtime}`);
  }
  const packages = names
    .filter((name) => !opts.only || opts.only.includes(name))
    .flatMap((name): ListedDependency[] => {
      const latest = latestVersions.get(name);
      if (!latest) return [];
      return [...(declared.get(name) ?? [])]
        .filter(([current]) => compareVersions(latest, current) > 0)
        .map(([current, declaredWorkspaces]) => {
          const from = parseVersion(current) ?? { major: 0, minor: 0, patch: 0 };
          const to = parseVersion(latest) ?? { major: 0, minor: 0, patch: 0 };
          const scanned = usage.get(name);
          return {
            name,
            current,
            latest,
            change: to.major > from.major ? 'major' : to.minor > from.minor ? 'minor' : 'patch',
            majorGap: Math.max(0, to.major - from.major),
            classification: scanned?.files.length
              ? 'used'
              : reasons.get(name)?.length
                ? 'tooling'
                : 'possibly-unused',
            reasons:
              !scanned?.files.length && !reasons.get(name)?.length
                ? [
                    UNUSED_REASON,
                    ...(failures.some((f) => f.name === name)
                      ? ['tooling/peer metadata incomplete; install dependencies and scan again']
                      : []),
                  ]
                : (reasons.get(name) ?? []),
            tier: tierOf([zodPack, stripePack], name, current, latest),
            workspaces: declaredWorkspaces,
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
          };
        });
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
  const groups = dependencyGroups(packages, metadata, targets);
  return {
    repo: opts.cwd,
    workspaces,
    packages,
    groups,
    unknown: names
      .filter((name) => (!opts.only || opts.only.includes(name)) && !latestVersions.has(name))
      .map((name) => ({
        name,
        currentVersions: [...(declared.get(name)?.keys() ?? [])],
        workspaces: [...new Set([...(declared.get(name)?.values() ?? [])].flat())],
        reason:
          failures.find((failure) => failure.name === name)?.reason ?? 'latest version unavailable',
      })),
    failures: [...new Map(failures.map((failure) => [failure.name, failure])).values()],
    timing: { totalMs: Date.now() - start },
  };
}
