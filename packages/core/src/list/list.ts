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
import {
  installedManifest,
  knownTool,
  type Manifest,
  toolingReasons,
  UNUSED_REASON,
} from './evidence.js';
import { dependencyGroups } from './groups.js';
import {
  createDiscoveryFetcher,
  DiscoveryRegistryError,
  registryFailure,
  registryHost,
} from './registry.js';
import { scanImports } from './scan.js';
import { dependencySource } from './spec.js';

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export interface ListedDependency {
  name: string;
  /** The real registry name when the manifest uses an npm alias. */
  registryName?: string;
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
    for (const [name, spec] of Object.entries({
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.optionalDependencies,
    })) {
      const source = dependencySource(name, spec);
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
      const versions = declared.get(key) ?? new Map<string, string[]>();
      versions.set(version, [...(versions.get(version) ?? []), workspace]);
      declared.set(key, versions);
    }
  }
  const names = [...declared.keys()].sort();
  const configs: string[] = [];
  const fileEvidence = new Map<string, string[]>();
  const usage = scanImports(
    opts.cwd,
    [...new Set(names.map(localName))],
    workspaces,
    configs,
    fileEvidence,
  );
  const scripts = manifests.flatMap((m) => Object.values(m.scripts ?? {})).join('\n');
  const metadata = new Map<string, Manifest[]>();
  const targets = new Map<string, Manifest>();
  const latestVersions = new Map<string, string>();
  await mapWithLimit(names, 16, async (name) => {
    const items: Manifest[] = [];
    const missing: string[] = [];
    for (const [version, locations] of declared.get(name) ?? []) {
      const local = locations
        .map((w) => installedManifest(opts.cwd, w, localName(name)))
        .filter((m): m is Manifest => !!m && (!m.version || m.version === version));
      if (local.length) items.push(...local);
      else missing.push(version);
    }
    metadata.set(name, items);
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
      } catch (error) {
        fail(name, error);
        blocked.add(name);
      }
    }
    for (const version of missing) {
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
        ),
        ...(!knownTool(localName(name)) && knownTool(registryName(name))
          ? ['known configuration or build tool']
          : []),
        ...(fileEvidence.get(localName(name)) ?? []),
      ],
    ]),
  );
  // Peers of used packages (including up-to-date ones) are required without source imports.
  const needed = new Set(
    names.filter((name) => usage.has(localName(name)) || (reasons.get(name)?.length ?? 0) > 0),
  );
  for (const name of needed) {
    for (const m of metadata.get(name) ?? []) {
      for (const peer of Object.keys(m.peerDependencies ?? {})) {
        for (const key of names.filter((key) => localName(key) === peer)) {
          const evidence = reasons.get(key) as string[];
          const reason = `peer dependency of ${localName(name)}`;
          if (!evidence.includes(reason)) evidence.push(reason);
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
      return [...(declared.get(name) ?? [])]
        .filter(([current]) => compareVersions(latest, current) > 0)
        .map(([current, declaredWorkspaces]) => {
          const from = parseVersion(current) ?? { major: 0, minor: 0, patch: 0 };
          const to = parseVersion(latest) ?? { major: 0, minor: 0, patch: 0 };
          const scanned = usage.get(localName(name));
          return {
            name: localName(name),
            ...(registryName(name) !== localName(name) ? { registryName: registryName(name) } : {}),
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
                    ...(failures.some((f) => f.name === localName(name))
                      ? ['tooling/peer metadata incomplete; install dependencies and scan again']
                      : []),
                  ]
                : (reasons.get(name) ?? []),
            tier: tierOf([zodPack, stripePack], localName(name), current, latest),
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
    skipped: [...skipped.values()].sort(
      (a, b) => compareText(a.name, b.name) || compareText(a.source, b.source),
    ),
    unknown: [...unknown.values()],
    failures: [...failuresByName.values()],
    timing: { totalMs: Date.now() - start },
  };
}
