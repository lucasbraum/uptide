import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { CliError } from './errors.js';
import { binaryBunLockfile, noLockfile, noProject, yarnPlugAndPlay } from './failures.js';

export type PackageManager = 'pnpm' | 'npm' | 'yarn' | 'bun';

export interface Repo {
  /** Nearest directory with a package.json, from `--cwd` upwards. */
  root: string;
  name: string | undefined;
  manager: PackageManager;
  /** Absolute path; in a workspace package it sits at the workspace root, above `root`. */
  lockfile: string;
  /** Why this lockfile, when others sit next to it: `packageManager` says so, or precedence. */
  chosen?: string;
  /** Workspace packages relative to `root`, the root itself (`.`) first. */
  workspaces: string[];
}

const LOCKFILES: [string, PackageManager][] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['package-lock.json', 'npm'],
  ['npm-shrinkwrap.json', 'npm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
];

function upwards<T>(from: string, visit: (dir: string) => T | undefined): T | undefined {
  let dir = resolve(from);
  for (;;) {
    const found = visit(dir);
    if (found !== undefined) return found;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export function findProjectRoot(cwd: string): string | undefined {
  return upwards(cwd, (dir) => (existsSync(join(dir, 'package.json')) ? dir : undefined));
}

/**
 * The lockfile the repository means: at the nearest directory that has any, the one the
 * `packageManager` field names (corepack's choice), else the first by precedence. Others
 * next to it are named and never written.
 */
export function findLockfile(
  root: string,
): { file: string; manager: PackageManager; chosen?: string } | undefined {
  const declared = declaredManager(root);
  return upwards(root, (dir) => {
    const present = LOCKFILES.filter(([name]) => existsSync(join(dir, name)));
    const byDeclaration = present.find(([, manager]) => manager === declared);
    const pick = byDeclaration ?? present[0];
    if (!pick) return undefined;
    const others = present.filter((p) => p !== pick).map(([name]) => name);
    return {
      file: join(dir, pick[0]),
      manager: pick[1],
      ...(others.length
        ? {
            chosen: `${pick[0]} (${byDeclaration ? `packageManager says ${declared}` : 'first by precedence: pnpm, npm, yarn, bun'}); ${others.join(', ')} left untouched`,
          }
        : {}),
    };
  });
}

/** What `packageManager` in package.json (corepack) says, here or in a parent. */
export function declaredManager(root: string): PackageManager | undefined {
  return upwards(root, (dir) => {
    try {
      const field = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).packageManager;
      const name = typeof field === 'string' ? field.split('@')[0] : undefined;
      return name === 'pnpm' || name === 'npm' || name === 'yarn' || name === 'bun'
        ? name
        : undefined;
    } catch {
      return undefined;
    }
  });
}

/**
 * Repository, package manager and workspaces, from the filesystem alone. `workspacesOf`
 * is the engine's reading of `pnpm-workspace.yaml` / `workspaces`, so both agree.
 */
export async function detectRepo(
  cwd: string,
  workspacesOf: (root: string) => Promise<string[]>,
): Promise<Repo> {
  const root = findProjectRoot(cwd);
  if (!root) throw noProject(cwd);
  const lock = findLockfile(root);
  if (!lock) {
    const bun = upwards(root, (dir) => (existsSync(join(dir, 'bun.lockb')) ? dir : undefined));
    throw bun ? binaryBunLockfile(bun) : noLockfile(root, declaredManager(root));
  }
  if (lock.manager === 'yarn' && existsSync(join(dirname(lock.file), '.pnp.cjs')))
    throw yarnPlugAndPlay(dirname(lock.file));
  let name: string | undefined;
  try {
    name = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name;
  } catch {
    throw new CliError(`${join(root, 'package.json')} is not valid JSON`);
  }
  return {
    root,
    name,
    manager: lock.manager,
    lockfile: lock.file,
    ...(lock.chosen ? { chosen: lock.chosen } : {}),
    workspaces: await workspacesOf(root),
  };
}

export function describeRepo(repo: Repo): string {
  const packages = repo.workspaces.filter((w) => w !== '.').length;
  const shape =
    packages > 0
      ? `${repo.manager} workspace, ${packages} package${packages === 1 ? '' : 's'}`
      : repo.manager;
  return `${repo.name ?? repo.root} (${shape})${repo.chosen ? ` · ${repo.chosen}` : ''}`;
}
