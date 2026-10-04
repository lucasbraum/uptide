import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { typescriptAdapter } from '../adapters/typescript/index.js';
import { type CheckOptions, type CheckResult, check } from '../check/check.js';
import { mapWithLimit } from '../check/pool.js';
import type { PackageFetcher } from '../domain/io.js';
import { createNpmFetcher, releasePackage } from '../fetch/npm-fetcher.js';
import { type PeerLookup, planUpgrades, type UpgradePlan } from './plan.js';

interface Manifest {
  version?: string;
  peerDependencies?: Record<string, string>;
}

function manifestAt(dir: string): Manifest | undefined {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Manifest;
  } catch {
    return undefined;
  }
}

/** The installed copy of `name` as Node would find it from `from`. */
function installedManifest(from: string, name: string): Manifest | undefined {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return manifestAt(candidate);
    if (dirname(dir) === dir) return undefined;
  }
}

export interface PlanServices {
  check?: (opts: CheckOptions) => Promise<CheckResult>;
  fetcher?: PackageFetcher;
}

/**
 * `check`, then the order to act on it: the peer ranges are read from the installed
 * manifests and from the target tarballs `check` already downloaded. Nothing is installed
 * and nothing in the repository is executed.
 */
export async function upgradePlan(
  opts: CheckOptions,
  services: PlanServices = {},
): Promise<{ report: CheckResult; plan: UpgradePlan }> {
  const report = await (services.check ?? check)(opts);
  const fetcher = services.fetcher ?? opts.fetcher ?? createNpmFetcher();
  const adapter = opts.adapter ?? typescriptAdapter;
  const installed: PeerLookup['installed'] = {};
  for (const workspace of report.workspaces) {
    const dir = resolve(opts.cwd, workspace);
    for (const [name, version] of (await adapter.installedDependencies?.({ dir })) ?? []) {
      if (/^(link|workspace|file):/.test(version) || installed[name]) continue;
      const manifest = installedManifest(dir, name);
      if (manifest) installed[name] = { version, peers: manifest.peerDependencies ?? {} };
    }
  }
  // The targets worth asking about: what the plan would upgrade.
  const targets = report.packages
    .filter((p) => p.status !== 'skipped' && p.installed !== p.target)
    .flatMap((p) => p.members ?? [p])
    .filter((p) => !/^(link|workspace|file):/.test(p.installed));
  const ofTarget = new Map<string, Record<string, string> | undefined>();
  await mapWithLimit(targets, 6, async (p) => {
    try {
      const pkg = await fetcher.fetch(p.name, p.target);
      ofTarget.set(`${p.name}@${p.target}`, manifestAt(pkg.dir)?.peerDependencies ?? {});
      await releasePackage(fetcher, pkg);
    } catch {
      // A target that cannot be fetched constrains nothing we can state.
      ofTarget.set(`${p.name}@${p.target}`, undefined);
    }
  });
  const plan = planUpgrades(report, {
    installed,
    ofTarget: (name, version) => ofTarget.get(`${name}@${version}`),
  });
  return { report, plan };
}
