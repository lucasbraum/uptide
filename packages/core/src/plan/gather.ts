import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { CheckOptions, CheckResult } from '../check/check.js';
import { summarize } from '../check/check.js';
import { mapWithLimit } from '../check/pool.js';
import { compareVersions, majorsBehind } from '../check/version.js';
import type { PackageFetcher } from '../domain/io.js';
import type { CheckReport, PackageReport } from '../domain/report.js';
import { createNpmFetcher } from '../fetch/npm-fetcher.js';
import { loadRegistryConfig } from '../fetch/npmrc.js';
import { type ListOptions, type ListReport, listDependencies } from '../list/list.js';
import { type PeerLookup, planUpgrades, type UpgradePlan } from './plan.js';

export interface PlanOptions extends CheckOptions {
  checkResults?: CheckReport;
}
export interface PlanServices {
  list?: (opts: ListOptions) => Promise<ListReport>;
  fetcher?: PackageFetcher;
}

/** Discovery and optional saved evidence. Never compiles or downloads package tarballs. */
export async function upgradePlan(
  opts: PlanOptions,
  services: PlanServices = {},
): Promise<{ report: CheckResult; plan: UpgradePlan }> {
  const fetcher =
    services.fetcher ??
    opts.fetcher ??
    createNpmFetcher({ config: loadRegistryConfig({ cwd: opts.cwd }) });
  const discovery = await (services.list ?? listDependencies)({ ...opts, fetcher });
  const saved = opts.checkResults;
  if (saved && (!Array.isArray(saved.packages) || resolve(saved.repo) !== resolve(opts.cwd)))
    throw new Error('--results must be a check report for this repository');
  // A plan row is one installed version: workspaces on different versions upgrade apart.
  const byVersion = discovery.packages.flatMap((p) =>
    (p.versions ?? [{ version: p.current, workspaces: p.workspaces }])
      .filter((v) => compareVersions(p.latest, v.version) > 0)
      .map((v) => ({ ...p, current: v.version, workspaces: v.workspaces })),
  );
  const packages: PackageReport[] = byVersion.map((p) => {
    const existing = saved?.packages.find(
      (s) =>
        s.name === p.name &&
        s.installed === p.current &&
        s.target === p.latest &&
        JSON.stringify((s.workspaces ?? [s.workspace]).slice().sort()) ===
          JSON.stringify(p.workspaces.slice().sort()),
    );
    if (existing) return existing;
    return {
      name: p.name,
      installed: p.current,
      latest: p.latest,
      target: p.latest,
      tier: p.tier,
      workspace: p.workspaces.length > 1 ? '*' : (p.workspaces[0] ?? '.'),
      workspaces: p.workspaces,
      majorsBehind: majorsBehind(p.current, p.latest),
      findings: [],
      callSitesChecked: 0,
      unanalyzed: [],
      status: 'unknown',
      notes: ['not checked; effort unknown'],
      timing: { fetchMs: 0, diffMs: 0, usagesMs: 0, compileMs: 0 },
    };
  });
  for (const failure of discovery.failures)
    packages.push({
      name: failure.name,
      installed: '?',
      latest: '?',
      target: '?',
      workspace: failure.workspace ?? '.',
      majorsBehind: 0,
      findings: [],
      callSitesChecked: 0,
      unanalyzed: [],
      status: 'skipped',
      skipReason: 'ANALYSIS_FAILED',
      notes: [failure.reason],
      timing: { fetchMs: 0, diffMs: 0, usagesMs: 0, compileMs: 0 },
    });
  const report: CheckResult = {
    repo: opts.cwd,
    workspaces: discovery.workspaces,
    packages,
    summary: summarize(packages),
    timing: discovery.timing,
  };
  const installed: PeerLookup['installed'] = {};
  for (const workspace of discovery.workspaces) {
    const dir = resolve(opts.cwd, workspace);
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    for (const name of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) {
      for (let at = dir; ; at = dirname(at)) {
        try {
          const pkg = JSON.parse(
            readFileSync(join(at, 'node_modules', name, 'package.json'), 'utf8'),
          ) as { version: string; peerDependencies?: Record<string, string> };
          installed[name] ??= { version: pkg.version, peers: pkg.peerDependencies ?? {} };
          break;
        } catch {
          if (dirname(at) === at) break;
        }
      }
    }
  }
  const targets = new Map<string, Record<string, string> | undefined>();
  await mapWithLimit(discovery.packages, 12, async (p) => {
    try {
      targets.set(
        `${p.name}@${p.latest}`,
        (await fetcher.metadata?.(p.name, p.latest))?.peerDependencies,
      );
    } catch {
      /* Missing metadata is disclosed, never mistaken for proof of compatibility. */
    }
  });
  const plan = planUpgrades(report, {
    installed,
    ofTarget: (name, version) => targets.get(`${name}@${version}`),
  });
  plan.notes = [
    'Based on discovery and matching saved check results; unknown effort requires uptide check <package>.',
    'Saved results describe the source at check time; rerun check after source changes.',
  ];
  for (const name of new Set(byVersion.map((p) => p.name))) {
    const versions = byVersion.filter((p) => p.name === name);
    if (versions.length > 1)
      plan.notes.push(
        `${name}: current versions ${versions.map((p) => `${p.current} (${p.workspaces.join(', ')})`).join('; ')}; one target for all, highest estimated effort shown.`,
      );
  }
  const missing = discovery.packages.filter(
    (p) => targets.get(`${p.name}@${p.latest}`) === undefined,
  );
  if (missing.length)
    plan.notes.push(`Target peer metadata unavailable: ${missing.map((p) => p.name).join(', ')}`);
  if (!Object.keys(installed).length)
    plan.notes.push('Installed peer constraints unavailable without node_modules.');
  return { report, plan };
}
