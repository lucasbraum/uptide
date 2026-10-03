// What the public tree is, and whether it is clean: the tracked files minus the export's
// exclusion list, with no private planning document, no pointer to an excluded file and no
// identifier from the private denylist. Used by the test suite, by CI and by the export.
//
//   node scripts/public-tree.mjs [dir] [--json] [--require-denylist]
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXCLUDE_LIST = 'scripts/public-export-exclude.txt';
export const DENYLIST_FILE = 'scripts/private-denylist.txt';
export const DENYLIST_ENV = 'UPTIDE_PRIVATE_DENYLIST';

/** One entry per line, `#` comments skipped; the environment variable may use commas instead. */
const entries = (text, separator = '\n') =>
  text
    .split(separator)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));

/** The exclusion list of `root`; a tree without one (never the case here) excludes nothing. */
export function exclusions(root) {
  const path = join(root, EXCLUDE_LIST);
  return existsSync(path) ? entries(readFileSync(path, 'utf8')) : [];
}

export const isExcluded = (path, excluded) =>
  excluded.some((entry) => (entry.endsWith('/') ? path.startsWith(entry) : path === entry));

export function trackedFiles(root) {
  return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
}

/** What a public export contains: everything tracked that the list does not hold back. */
export function publicFiles(root, excluded = exclusions(root)) {
  return trackedFiles(root).filter((path) => !isExcluded(path, excluded));
}

/** The private identifiers: the environment first, else the private file, else unknown. */
export function denylist(root, env = process.env) {
  if (env[DENYLIST_ENV]) return entries(env[DENYLIST_ENV], /[\n,]/);
  const path = join(root, DENYLIST_FILE);
  return existsSync(path) ? entries(readFileSync(path, 'utf8')) : undefined;
}

/** Private planning and audit documents, whatever they are called next time. */
const PRIVATE_DOC = /(^|\/)(plan|roadmap|privacy-audit|audit)[^/]*\.md$/i;
/** The files whose job is to name the excluded paths. */
const NAMES_THEM = new Set([EXCLUDE_LIST, 'scripts/public-tree.mjs', '.gitignore']);
const TEXT =
  /\.(md|ts|tsx|mts|mjs|js|json|ya?ml|txt|snap|html|css|sh)$|(^|\/)\.[\w.-]+$|(^|\/)LICENSE$/;

/** Lowercase entries match in any case; an entry with an uppercase letter matches as written. */
const matcher = (term) =>
  term === term.toLowerCase()
    ? (text) => text.toLowerCase().includes(term)
    : (text) => text.includes(term);

/**
 * Everything wrong with the public tree of `root`, as sentences. A denylist hit names the
 * file and the identifier, never the line: this output ends up in CI logs.
 */
export function problems(root, terms = denylist(root)) {
  const excluded = exclusions(root);
  const tracked = trackedFiles(root);
  const tree = tracked.filter((path) => !isExcluded(path, excluded));
  const found = [];
  for (const path of tracked)
    if (/(^|\/)plan-[^/]*\.md$/i.test(path))
      found.push(`${path}: a plan is pasted into briefs, never committed`);
  for (const path of tree)
    if (PRIVATE_DOC.test(path))
      found.push(`${path}: a private planning or audit document in the public tree`);
  // A file is pointed at by its name wherever it is mentioned; a directory by its full path.
  const names = excluded.map((entry) => (entry.endsWith('/') ? entry : entry.split('/').pop()));
  const matchers = (terms ?? []).map((term) => [term, matcher(term)]);
  for (const path of tree) {
    for (const [term, matches] of matchers)
      if (matches(path)) found.push(`${path}: the path contains the private identifier "${term}"`);
    const file = join(root, path);
    if (!TEXT.test(path) || !existsSync(file)) continue;
    const text = readFileSync(file, 'utf8');
    if (!NAMES_THEM.has(path))
      for (const name of names)
        if (text.includes(name))
          found.push(`${path}: points at ${name}, which the export leaves out`);
    for (const [term, matches] of matchers)
      if (matches(text)) found.push(`${path}: contains the private identifier "${term}"`);
  }
  return found;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const root = resolve(args.find((a) => !a.startsWith('--')) ?? '.');
  const terms = denylist(root);
  if (!terms && args.includes('--require-denylist')) {
    console.error(`no denylist: set ${DENYLIST_ENV} or provide ${DENYLIST_FILE}`);
    process.exit(2);
  }
  const found = problems(root, terms);
  if (args.includes('--json')) {
    console.log(
      JSON.stringify({ files: publicFiles(root).length, denylist: terms?.length, problems: found }),
    );
  } else {
    const scope = terms ? `${terms.length} private identifiers` : 'no denylist available';
    console.log(`public tree of ${root}: ${publicFiles(root).length} files, ${scope}`);
    for (const line of found) console.log(`  ✗ ${line}`);
    console.log(found.length ? `${found.length} problems` : 'clean');
  }
  process.exit(found.length ? 1 : 0);
}
