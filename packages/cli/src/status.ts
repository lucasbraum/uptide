import { join } from 'node:path';
import { compareVersions, majorsBehind } from '@uptide/core';
import pc from 'picocolors';
import type { Repo } from './detect.js';
import type { Engine } from './engine.js';

/** The dependencies uptide migrates today. */
export const SUPPORTED = ['zod', 'stripe'] as const;

export interface DependencyStatus {
  name: string;
  /** Workspace packages declaring it, relative to the repository root. */
  workspaces: string[];
  /** Pinned through a pnpm catalog in at least one of them. */
  catalog: boolean;
  /** Lowest locked version across workspaces; undefined when no package declares it. */
  installed?: string;
  /** Undefined when the registry could not be reached. */
  latest?: string;
  majorsBehind?: number;
}

export interface StatusReport {
  repo: string;
  name?: string;
  packageManager: string;
  lockfile: string;
  workspaces: string[];
  dependencies: DependencyStatus[];
  /** Why `latest` is missing, when it is. */
  registryError?: string;
}

/** Which workspace packages declare each dependency, and the lowest version the lockfile pins. */
export async function locateDependencies(
  repo: Repo,
  engine: Engine,
  names: readonly string[] = SUPPORTED,
): Promise<DependencyStatus[]> {
  const dependencies: DependencyStatus[] = names.map((name) => ({
    name,
    workspaces: [],
    catalog: false,
  }));
  for (const workspace of repo.workspaces) {
    const dir = join(repo.root, workspace);
    const [installed, declared] = await Promise.all([engine.installed(dir), engine.declared(dir)]);
    for (const dep of dependencies) {
      const spec = declared.get(dep.name);
      if (spec === undefined) continue;
      dep.workspaces.push(workspace);
      if (spec.startsWith('catalog:')) dep.catalog = true;
      const version = installed.get(dep.name);
      if (version && (!dep.installed || compareVersions(version, dep.installed) < 0))
        dep.installed = version;
    }
  }
  return dependencies;
}

/** Where each supported dependency stands: the lockfile plus one registry lookup each. */
export async function collectStatus(
  repo: Repo,
  engine: Engine,
  names: readonly string[] = SUPPORTED,
): Promise<StatusReport> {
  const dependencies = await locateDependencies(repo, engine, names);
  let registryError: string | undefined;
  await Promise.all(
    dependencies
      .filter((dep) => dep.workspaces.length > 0)
      .map(async (dep) => {
        try {
          dep.latest = await engine.latest(dep.name);
          if (dep.installed) dep.majorsBehind = majorsBehind(dep.installed, dep.latest);
        } catch (err) {
          registryError = err instanceof Error ? err.message : String(err);
        }
      }),
  );
  return {
    repo: repo.root,
    name: repo.name,
    packageManager: repo.manager,
    lockfile: repo.lockfile,
    workspaces: repo.workspaces,
    dependencies,
    ...(registryError ? { registryError } : {}),
  };
}

function verdict(dep: DependencyStatus): string {
  if (dep.workspaces.length === 0) return 'not a dependency';
  if (!dep.installed) return 'declared, not in the lockfile';
  if (!dep.latest) return `${dep.installed} installed, latest unknown`;
  if (compareVersions(dep.installed, dep.latest) >= 0)
    return `${dep.installed} installed, up to date`;
  const majors = dep.majorsBehind ?? 0;
  const behind = majors === 0 ? 'same major' : `${majors} major${majors === 1 ? '' : 's'} behind`;
  return `${dep.installed} installed, latest ${dep.latest}, ${behind}`;
}

export function formatStatus(report: StatusReport, opts: { color?: boolean } = {}): string {
  const colors = pc.createColors(opts.color ?? true);
  const packages = report.workspaces.filter((w) => w !== '.').length;
  const lines = [
    `${colors.dim('Repository')}  ${report.name ? `${report.name}  ${colors.dim(report.repo)}` : report.repo}`,
    `${colors.dim('Manager')}     ${report.packageManager}${packages > 0 ? `, ${packages} workspace package${packages === 1 ? '' : 's'}` : ''}`,
    '',
  ];
  const width = Math.max(...report.dependencies.map((d) => d.name.length));
  for (const dep of report.dependencies) {
    const where =
      packages > 0 && dep.workspaces.length > 0
        ? colors.dim(`  ${dep.workspaces.join(', ')}${dep.catalog ? ' (catalog)' : ''}`)
        : '';
    const text = verdict(dep);
    const behind = (dep.majorsBehind ?? 0) > 0;
    lines.push(
      `${colors.bold(dep.name.padEnd(width))}  ${behind ? colors.yellow(text) : text}${where}`,
    );
  }
  lines.push('');
  const used = report.dependencies.filter((d) => d.workspaces.length > 0);
  if (report.registryError)
    lines.push(
      `Could not reach the npm registry (${report.registryError}), so latest versions are unknown.`,
      `  ${colors.bold('Next:')} npm ping`,
    );
  if (used.length === 0)
    lines.push(
      `Neither ${report.dependencies.map((d) => d.name).join(' nor ')} is a dependency here; those are the upgrades uptide covers today.`,
    );
  else if (
    used.some((d) => !d.latest || !d.installed || compareVersions(d.installed, d.latest) < 0)
  )
    lines.push(`Run ${colors.bold('`uptide check`')} for impact.`);
  else lines.push('Nothing to upgrade.');
  return `${lines.join('\n')}\n`;
}
