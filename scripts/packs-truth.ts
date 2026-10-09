/**
 * A draft of the expected findings for one ground-truth repository, from two sources that are
 * not Uptide: the repository's own upgrade commit, and its own TypeScript compiler.
 *
 *   pnpm packs:truth <package> <owner/name> <commit> <upgrade-commit> --to <version>
 *     [--directory <dir>] [--also <companion>@<version> ...]
 *
 * - changed: every line of `<commit>` the upgrade commit changed or removed (`git diff -U0`,
 *   the old side), in source files. Pure insertions have no line in `<commit>` and are listed
 *   apart.
 * - compiler: the diagnostics the repository's own TypeScript reports with the target version
 *   swapped in and not without it, errors and deprecations (6385, 6387), keyed on file, code
 *   and message. The target is linked where the repository has the package installed, as an
 *   install of it would put it.
 *
 * It prints JSON for docs/packs.md, "Ground truth": you read each site, drop what is not about
 * the package, and give every kept site its rule. Nothing here comes from `check`.
 */
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { createNpmFetcher, ensureRepo, maxSatisfying, satisfies, validRange } from '@uptide/core';
import { compilerDiagnostics, type Diagnostic } from './packs-truth-compiler.ts';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const positional = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const [pkg, repo, commit, upgrade] = positional;
const to = flag('--to');
const directory = flag('--directory');
if (!pkg || !repo || !commit || !upgrade || !to) {
  console.error(
    'usage: pnpm packs:truth <package> <owner/name> <commit> <upgrade-commit> --to <version> [--directory <dir>]',
  );
  process.exit(2);
}

const root = await ensureRepo(
  { repo, commit, ...(directory ? { directory } : {}) },
  { log: (line) => console.error(line) },
);
const project = directory ? join(root, directory) : root;

// The upgrade commit, next to the pinned one: one more shallow fetch.
const git = (...a: string[]) =>
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...a], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
git('fetch', '-q', '--depth', '1', '--no-tags', 'origin', upgrade);
const SOURCE = /\.[cm]?[jt]sx?$/;
const changed: { file: string; line: number; text: string }[] = [];
const inserted: { file: string; after: number; text: string }[] = [];
let file = '';
let oldLine = 0;
let newRun = false;
for (const line of git('diff', '-U0', '--no-color', '--no-ext-diff', commit, upgrade).split('\n')) {
  if (line.startsWith('--- ')) continue;
  if (line.startsWith('+++ ')) {
    file = line.slice(4).replace(/^b\//, '');
    continue;
  }
  const hunk = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/.exec(line);
  if (hunk) {
    oldLine = Number(hunk[1]);
    newRun = hunk[2] === '0';
    if (newRun) oldLine += 1;
    continue;
  }
  if (!SOURCE.test(file) || (directory && !file.startsWith(`${directory}/`))) continue;
  const where = directory ? relative(directory, file) : file;
  if (line.startsWith('-'))
    changed.push({ file: where, line: oldLine++, text: line.slice(1).trim() });
  else if (line.startsWith('+') && newRun)
    inserted.push({ file: where, after: oldLine - 1, text: line.slice(1).trim() });
}

// Where the repository has the package: the root's node_modules and each workspace's.
function installs(name: string, dir: string, depth = 0): string[] {
  const found: string[] = [];
  const own = join(dir, 'node_modules', ...name.split('/'));
  if (existsSync(own)) found.push(relative(project, own));
  if (depth >= 3) return found;
  for (const entry of readdirSync(dir, { withFileTypes: true }))
    if (entry.isDirectory() && !['node_modules', '.git', 'dist', 'build'].includes(entry.name))
      found.push(...installs(name, join(dir, entry.name), depth + 1));
  return found;
}
function tsconfigs(dir: string, depth = 0): string[] {
  const found = existsSync(join(dir, 'tsconfig.json'))
    ? [relative(project, join(dir, 'tsconfig.json'))]
    : [];
  if (depth >= 3) return found;
  for (const entry of readdirSync(dir, { withFileTypes: true }))
    if (entry.isDirectory() && !['node_modules', '.git', 'dist', 'build'].includes(entry.name))
      found.push(...tsconfigs(join(dir, entry.name), depth + 1));
  return found;
}
const configs = tsconfigs(project);
const fetcher = createNpmFetcher();
const work = mkdtempSync(join(tmpdir(), 'uptide-truth-'));

// The target, and the companions the upgrade moved with it (`--also @ai-sdk/react@4.0.10`).
const swaps: { name: string; version: string }[] = [
  { name: pkg, version: to },
  ...args
    .filter((_a, i) => args[i - 1] === '--also')
    .map((spec) => {
      const at = spec.lastIndexOf('@');
      return { name: spec.slice(0, at), version: spec.slice(at + 1) };
    }),
];
/** The version of `name` the repository resolves from `from` upward, with its real directory. */
function consumerCopy(name: string, from: string): { version: string; dir: string } | undefined {
  for (let dir = from; ; dir = dirname(dir)) {
    const manifest = join(dir, 'node_modules', ...name.split('/'), 'package.json');
    if (existsSync(manifest))
      return {
        version: JSON.parse(readFileSync(manifest, 'utf8')).version,
        dir: realpathSync(dirname(manifest)),
      };
    if (dirname(dir) === dir || !dir.startsWith(root)) return undefined;
  }
}

/**
 * A package at a version, as an install of it would leave it: a copy with its own
 * `node_modules`, each dependency the repository's copy when that satisfies the declared
 * range (peers always the repository's), else the highest version inside the range, fetched
 * and assembled the same way. What check does for the target (target-deps.ts).
 */
async function assemble(name: string, version: string, depth = 0): Promise<string> {
  const dir = join(work, `${name.replace('/', '__')}@${version}`);
  if (existsSync(dir)) return dir;
  cpSync((await fetcher.fetch(name, version)).dir, dir, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };
  const link = (dep: string, at: string) => {
    const into = join(dir, 'node_modules', ...dep.split('/'));
    mkdirSync(dirname(into), { recursive: true });
    if (!existsSync(into)) symlinkSync(at, into);
  };
  for (const dep of Object.keys(manifest.peerDependencies ?? {})) {
    const own = consumerCopy(dep, project);
    if (own) link(dep, own.dir);
  }
  for (const [dep, range] of Object.entries(manifest.dependencies ?? {})) {
    if (!validRange(range)) continue;
    // A version the upgrade pinned (`--also`) wins, as one deduplicated copy in its lockfile does.
    const pinned = swaps.find((swap) => swap.name === dep && satisfies(swap.version, range));
    const own = consumerCopy(dep, project);
    if (pinned) link(dep, await assemble(pinned.name, pinned.version, depth + 1));
    else if (own && satisfies(own.version, range)) link(dep, own.dir);
    else if (depth < 4) {
      const best = maxSatisfying((await fetcher.versions?.(dep)) ?? [], range);
      if (best) link(dep, await assemble(dep, best, depth + 1));
    }
  }
  return dir;
}

const links: { at: string; dir: string }[] = [];
for (const swap of swaps) {
  const dir = await assemble(swap.name, swap.version);
  for (const at of installs(swap.name, project)) links.push({ at, dir });
}

const {
  compiler: compilerName,
  diagnostics: baseline,
  notCompiled,
} = compilerDiagnostics(project, configs);
for (const link of links) {
  const at = join(project, link.at);
  renameSync(at, `${at}.uptide-orig`);
  symlinkSync(link.dir, at);
}
let after: Diagnostic[];
try {
  after = compilerDiagnostics(project, configs).diagnostics;
} finally {
  rmSync(work, { recursive: true, force: true, maxRetries: 2 });
  for (const link of links) {
    const at = join(project, link.at);
    if (lstatSync(at).isSymbolicLink()) rmSync(at);
    renameSync(`${at}.uptide-orig`, at);
  }
}
const key = (d: Diagnostic) => `${d.file} ${d.code} ${d.message}`;
const pool = new Map<string, number>();
for (const d of baseline) pool.set(key(d), (pool.get(key(d)) ?? 0) + 1);
const compiler = after.filter((d) => {
  const left = pool.get(key(d)) ?? 0;
  if (left > 0) {
    pool.set(key(d), left - 1);
    return false;
  }
  return true;
});

console.log(
  JSON.stringify(
    {
      repo,
      commit,
      upgrade,
      ...(directory ? { directory } : {}),
      to,
      links: links.map((l) => `${l.at} → ${basename(l.dir)}`),
      compiledWith: compilerName,
      tsconfigs: configs,
      notCompiled,
      compiler: compiler.map((d) => ({
        ...d,
        message: d.message.slice(0, 200),
        text: (readFileSync(join(project, d.file), 'utf8').split('\n')[d.line - 1] ?? '').trim(),
      })),
      changed,
      inserted,
    },
    null,
    2,
  ),
);
