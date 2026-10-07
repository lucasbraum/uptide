/**
 * A draft of the expected findings for one ground-truth repository, from two sources that are
 * not Uptide: the repository's own upgrade commit, and its own TypeScript compiler.
 *
 *   pnpm packs:truth <package> <owner/name> <commit> <upgrade-commit> --to <version> [--directory <dir>]
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
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { createNpmFetcher, ensureRepo } from '@uptide/core';
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
function installs(dir: string, depth = 0): string[] {
  const found: string[] = [];
  const own = join(dir, 'node_modules', ...pkg.split('/'));
  if (existsSync(own)) found.push(relative(project, own));
  if (depth >= 3) return found;
  for (const entry of readdirSync(dir, { withFileTypes: true }))
    if (entry.isDirectory() && !['node_modules', '.git', 'dist', 'build'].includes(entry.name))
      found.push(...installs(join(dir, entry.name), depth + 1));
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
const links = installs(project);
const configs = tsconfigs(project);
const fetcher = createNpmFetcher();
const target = await fetcher.fetch(pkg, to);

const { compiler: compilerName, diagnostics: baseline } = compilerDiagnostics(project, configs);
for (const link of links) {
  const at = join(project, link);
  renameSync(at, `${at}.uptide-orig`);
  symlinkSync(target.dir, at);
}
let after: Diagnostic[];
try {
  after = compilerDiagnostics(project, configs).diagnostics;
} finally {
  for (const link of links) {
    const at = join(project, link);
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
      links,
      compiledWith: compilerName,
      tsconfigs: configs,
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
