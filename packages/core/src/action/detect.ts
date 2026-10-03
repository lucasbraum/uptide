import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readLockfile } from '../adapters/typescript/lockfile.js';
import { workspacePackagesOf } from '../adapters/typescript/repo.js';
import { compareVersions } from '../check/version.js';
export type SupportedPackage = 'zod' | 'stripe';
export interface Upgrade {
  name: SupportedPackage;
  from: string;
  to: string;
  workspaces: string[];
}
export const resolutionFile = (file: string) =>
  /(^|\/)package\.json$/.test(file) ||
  /^(pnpm-lock\.yaml|pnpm-workspace\.yaml|package-lock\.json|yarn\.lock|bun\.lock)$/.test(file);
export function matchesPaths(file: string, patterns: string[]): boolean {
  if (!patterns.length) return true;
  return patterns.some((pattern) => {
    if (pattern.startsWith('/') || pattern.split('/').includes('..'))
      throw new Error('paths must be repository-relative');
    const re = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*\//g, '\u0001')
      .replace(/\*\*/g, '\u0002')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]')
      .split('\u0001')
      .join('(?:.*/)?')
      .split('\u0002')
      .join('.*');
    return (
      new RegExp(`^${re}$`).test(file) ||
      (!pattern.includes('*') && file.startsWith(`${pattern.replace(/\/$/, '')}/`))
    );
  });
}
function versions(root: string) {
  const result = new Map<string, Map<string, string>>();
  for (const workspace of workspacePackagesOf(root)) {
    const p = JSON.parse(readFileSync(join(root, workspace, 'package.json'), 'utf8'));
    const declared = new Map<string, string>(
      Object.entries({
        ...p.dependencies,
        ...p.devDependencies,
        ...p.optionalDependencies,
        ...p.peerDependencies,
      }),
    );
    result.set(workspace, readLockfile(join(root, workspace), declared)?.installed ?? new Map());
  }
  return result;
}
/** Lockfile importer versions cover direct, range-only and pnpm catalog bumps alike. */
export function detectUpgrades(
  base: string,
  head: string,
  changed: readonly string[],
  only: SupportedPackage[],
  paths: string[],
): Upgrade[] {
  if (!changed.some(resolutionFile)) return [];
  const a = versions(base),
    b = versions(head),
    groups = new Map<string, Upgrade>();
  for (const [workspace, deps] of b)
    for (const name of only) {
      const from = a.get(workspace)?.get(name),
        to = deps.get(name);
      if (
        !from ||
        !to ||
        !/^\d+\.\d+\.\d+/.test(from) ||
        !/^\d+\.\d+\.\d+/.test(to) ||
        compareVersions(from, to) >= 0
      )
        continue;
      if (
        paths.length &&
        !paths.some(
          (p) =>
            workspace === '.' ||
            p.startsWith(`${workspace}/`) ||
            matchesPaths(`${workspace}/package.json`, [p]),
        )
      )
        continue;
      const key = `${name}@${to}`;
      const known = groups.get(key);
      if (known) {
        known.workspaces.push(workspace);
        if (compareVersions(from, known.from) < 0) known.from = from;
      } else groups.set(key, { name, from, to, workspaces: [workspace] });
    }
  return [...groups.values()];
}
