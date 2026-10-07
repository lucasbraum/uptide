import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultCacheDir } from '../../cache/paths.js';
import { UptideError } from '../../errors.js';
import { packageManager } from '../../fix/managers/manager.js';
import { command, git } from '../../fix/process.js';
import type { GroundTruth, GroundTruthRepo } from '../contract.js';

/**
 * Ground-truth repositories are fetched once and kept: a shallow fetch of the one pinned
 * commit, dependencies installed with lifecycle scripts off, nothing from the repository ever
 * executed (no hook, no script; the same environment `fix` installs with). After the first
 * run `uptide pack test` needs no network but the registry tarballs `check` caches itself.
 */
export function truthCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.UPTIDE_GROUND_TRUTH_CACHE || join(defaultCacheDir(env), 'ground-truth');
}

/** What a corpus or ground-truth entry names: a public repository at a commit. */
export interface PinnedRepo {
  repo: string;
  commit: string;
}

const SHA = /^[0-9a-f]{40}$/;
const REPO = /^[\w.-]+\/[\w.-]+$/;

export function label(entry: GroundTruthRepo): string {
  return entry.fixture ?? `${entry.repo}@${(entry.commit ?? '').slice(0, 12)}`;
}

/** Everything wrong with a ground-truth file, as sentences: `pack test` refuses to score it. */
export function truthProblems(truth: GroundTruth, packageName: string): string[] {
  const problems: string[] = [];
  if (truth.package !== packageName)
    problems.push(`package is "${truth.package}", the pack is "${packageName}"`);
  truth.repos.forEach((r, i) => {
    const where = `repos[${i}]`;
    if (r.fixture === undefined) {
      if (!r.repo || !REPO.test(r.repo)) problems.push(`${where}: repo must be owner/name`);
      if (!r.commit || !SHA.test(r.commit))
        problems.push(`${where}: commit must be a full 40-character SHA`);
    } else if (r.repo || r.commit) problems.push(`${where}: a fixture has no repo or commit`);
    if (!r.from || !r.to) problems.push(`${where}: from and to are exact versions`);
    for (const f of r.findings ?? [])
      if (!f.file || !Number.isInteger(f.line) || f.line < 1 || !f.rule)
        problems.push(`${where}: every finding has a file, a line and a rule`);
  });
  return problems;
}

export function cachedRepoDir(entry: PinnedRepo, cacheDir = truthCacheDir()): string {
  return join(cacheDir, `${entry.repo.replace('/', '__')}@${entry.commit}`);
}

/** What a failed install said, in a few lines: the ones that say why, not the usage text. */
function why(output: string): string {
  const lines = output.split('\n').map((l) => l.trim());
  const reasons = lines.filter((l) => /ERR|error .*\S|Missing|not in sync|can only|ENOENT/.test(l));
  return (reasons.length ? reasons.slice(0, 4) : lines.filter(Boolean).slice(-4)).join(' | ');
}

/** Non-frozen installs, scripts still off: for a lockfile its own repository left out of sync. */
const UNFROZEN: Record<string, string[]> = {
  npm: ['install', '--ignore-scripts', '--no-audit', '--no-fund'],
  pnpm: ['install', '--ignore-scripts', '--no-frozen-lockfile'],
  'yarn-classic': ['install', '--ignore-scripts', '--non-interactive'],
  'yarn-berry': ['install'],
};

/**
 * The repository's own lockfile, frozen, with lifecycle scripts off. A repository whose
 * lockfile was already out of sync at that commit (it happens: `npm ci` refuses what `npm
 * install` accepted) is installed without freezing, scripts still off; `pack test` then
 * reports when the version it scores is not the ground truth's `from`.
 */
async function installDependencies(
  dir: string,
  name: string,
  options: EnsureOptions,
): Promise<{ manager: string; frozen: boolean }> {
  const pm = packageManager(dir);
  const env = { ...pm.env, npm_config_manage_package_manager_versions: 'true' };
  const timeout = options.timeoutMs ?? 900_000;
  options.log?.(`installing ${name} with ${pm.kind}, scripts off`);
  const result = await command(dir, pm.bin, pm.args, timeout, env);
  if (result.code === 0) return { manager: pm.kind, frozen: true };
  const retry = UNFROZEN[pm.kind] as string[];
  const args = pm.kind === 'yarn-berry' ? [...retry, ...pm.args.slice(2)] : retry;
  options.log?.(`the frozen install failed (${why(result.output)}); installing without freezing`);
  const again = await command(dir, pm.bin, args, timeout, env);
  if (again.code !== 0)
    throw new UptideError(
      'GROUND_TRUTH_INSTALL',
      `installing ${name} failed${again.timeout ? ' (timed out)' : ''}: ${why(again.output)}`,
    );
  return { manager: pm.kind, frozen: false };
}

interface Marker {
  repo: string;
  commit: string;
  installed: boolean;
  manager?: string;
}

const MARKER = '.uptide-ground-truth.json';

function readMarker(dir: string): Marker | undefined {
  try {
    return JSON.parse(readFileSync(join(dir, MARKER), 'utf8')) as Marker;
  } catch {
    return undefined;
  }
}

export interface EnsureOptions {
  cacheDir?: string;
  /** Never touch the network: a repository not in the cache is an error. */
  offline?: boolean;
  /** Install dependencies (default true): `check` needs them to type-check the repository. */
  install?: boolean;
  log?: (line: string) => void;
  /** Install timeout per repository, ms. */
  timeoutMs?: number;
}

/**
 * The directory of a pinned public repository, fetched and installed on first use. The
 * marker file is written last: a directory without it is an interrupted fetch and is
 * fetched again.
 */
export async function ensureRepo(entry: PinnedRepo, options: EnsureOptions = {}): Promise<string> {
  const cacheDir = options.cacheDir ?? truthCacheDir();
  const dir = cachedRepoDir(entry, cacheDir);
  const install = options.install ?? true;
  const marker = readMarker(dir);
  if (marker && (marker.installed || !install)) return dir;
  if (options.offline)
    throw new UptideError(
      'GROUND_TRUTH_NOT_CACHED',
      `${entry.repo}@${entry.commit.slice(0, 12)} is not in the ground-truth cache (${cacheDir}); run without --offline once, or pnpm packs:fetch`,
    );
  if (!SHA.test(entry.commit) || !REPO.test(entry.repo))
    throw new UptideError('INVALID_GROUND_TRUTH', `not a pinned public repository: ${entry.repo}`);
  if (!marker) {
    options.log?.(`fetching ${entry.repo}@${entry.commit.slice(0, 12)} (shallow)`);
    const partial = `${dir}.partial-${process.pid}`;
    rmSync(partial, { recursive: true, force: true });
    mkdirSync(partial, { recursive: true });
    try {
      git(partial, 'init', '-q');
      git(partial, 'remote', 'add', 'origin', `https://github.com/${entry.repo}.git`);
      git(partial, 'fetch', '-q', '--depth', '1', '--no-tags', 'origin', entry.commit);
      git(partial, 'checkout', '-q', '--detach', 'FETCH_HEAD');
      const head = git(partial, 'rev-parse', 'HEAD');
      if (head !== entry.commit) throw new Error(`fetched ${head}, expected ${entry.commit}`);
      rmSync(dir, { recursive: true, force: true });
      renameSync(partial, dir);
    } catch (err) {
      rmSync(partial, { recursive: true, force: true });
      throw new UptideError(
        'GROUND_TRUTH_FETCH',
        `cannot fetch ${entry.repo}@${entry.commit}: ${(err as Error).message.split('\n')[0]}`,
      );
    }
  }
  let installed = false;
  let manager: string | undefined;
  let frozen: boolean | undefined;
  if (install) {
    const result = await installDependencies(dir, entry.repo, options);
    manager = result.manager;
    frozen = result.frozen;
    installed = true;
  }
  writeFileSync(
    join(dir, MARKER),
    `${JSON.stringify({ repo: entry.repo, commit: entry.commit, installed, ...(manager ? { manager, frozen } : {}) })}\n`,
  );
  return dir;
}

/**
 * A fixture repository of this tree, installed in place (its `node_modules` is ignored by
 * git). Fixtures are synthetic: they are scored, never counted toward `verified`.
 */
export async function ensureFixture(
  root: string,
  fixture: string,
  options: EnsureOptions = {},
): Promise<string> {
  const dir = join(root, fixture);
  if (!existsSync(join(dir, 'package.json')))
    throw new UptideError('INVALID_GROUND_TRUTH', `no fixture repository at ${fixture}`);
  if (existsSync(join(dir, 'node_modules')) || options.install === false) return dir;
  if (options.offline)
    throw new UptideError(
      'GROUND_TRUTH_NOT_CACHED',
      `${fixture} has no node_modules; run without --offline once`,
    );
  await installDependencies(dir, fixture, options);
  return dir;
}
