import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { typescriptAdapter } from '../adapters/typescript/index.js';
import { mapWithLimit } from '../check/pool.js';
import { tierOf } from '../check/tier.js';
import { compareVersions, parseVersion } from '../check/version.js';
import type { LanguageAdapter } from '../domain/adapter.js';
import type { PackageFetcher } from '../domain/io.js';
import type { Tier } from '../domain/report.js';
import { createNpmFetcher } from '../fetch/npm-fetcher.js';
import { loadRegistryConfig } from '../fetch/npmrc.js';
import { stripePack } from '../packs/stripe/index.js';
import { zodPack } from '../packs/zod/index.js';

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

import { scanImports } from './scan.js';

export interface ListedDependency {
  name: string;
  current: string;
  latest: string;
  change: 'major' | 'minor' | 'patch';
  tier: Tier;
  workspaces: string[];
  usage: {
    files: number;
    callSites: number;
    topSymbols: { name: string; count: number }[];
    workspaces: string[];
  };
}
export interface ListReport {
  repo: string;
  workspaces: string[];
  packages: ListedDependency[];
  failures: { name: string; workspace?: string; reason: string }[];
  timing: { totalMs: number };
}
export interface ListOptions {
  cwd: string;
  only?: string[];
  adapter?: LanguageAdapter;
  fetcher?: Pick<PackageFetcher, 'resolve'>;
}

/** Discovery only. Reads manifests, lockfiles, source syntax and registry metadata. */
export async function listDependencies(opts: ListOptions): Promise<ListReport> {
  const start = Date.now();
  const adapter = opts.adapter ?? typescriptAdapter;
  const fetcher =
    opts.fetcher ?? createNpmFetcher({ config: loadRegistryConfig({ cwd: opts.cwd }) });
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
  const declared = new Map<string, Map<string, string[]>>();
  for (const workspace of workspaces) {
    const dir = resolve(opts.cwd, workspace);
    const installed =
      (await adapter.installedDependencies?.({ dir }).catch((error: unknown) => {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'NO_LOCKFILE')
          return new Map<string, string>();
        throw error;
      })) ?? new Map<string, string>();
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    for (const [name, spec] of Object.entries({
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.optionalDependencies,
    })) {
      if (opts.only && !opts.only.includes(name)) continue;
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
  const usage = scanImports(opts.cwd, names, workspaces);
  const packages = (
    await mapWithLimit(names, 12, async (name): Promise<ListedDependency[]> => {
      try {
        const latest = await fetcher.resolve(name, 'latest');
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
              tier: tierOf([zodPack, stripePack], name, current, latest),
              workspaces: declaredWorkspaces,
              usage: {
                files: scanned?.files.length ?? 0,
                callSites: scanned?.callSites ?? 0,
                workspaces: scanned?.workspaces.sort() ?? [],
                topSymbols: Object.entries(scanned?.symbols ?? {})
                  .sort(([a, ac], [b, bc]) => bc - ac || compareText(a, b))
                  .slice(0, 5)
                  .map(([name, count]) => ({ name, count })),
              },
            };
          });
      } catch (error) {
        failures.push({ name, reason: error instanceof Error ? error.message : String(error) });
        return [];
      }
    })
  ).flat();
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
  return {
    repo: opts.cwd,
    workspaces,
    packages,
    failures,
    timing: { totalMs: Date.now() - start },
  };
}
