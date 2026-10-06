// Whether this repository is clean of private material: no planning or audit document, and
// no identifier from the private denylist. The denylist is not in the repository: it comes
// from the UPTIDE_PRIVATE_DENYLIST environment variable (a secret in CI).
//
//   node scripts/public-tree.mjs [dir] [--json] [--require-denylist] [--every-file]
//
// `--every-file` scans every file under `dir` instead of git's tracked files: an unpacked
// npm tarball (scripts/check-pack.mjs) is not a repository.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DENYLIST_ENV = 'UPTIDE_PRIVATE_DENYLIST';

export function trackedFiles(root) {
  return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
}

export function everyFile(root) {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)));
}

/** The private identifiers, comma or newline separated; undefined when none were given. */
export function denylist(env = process.env) {
  const terms = (env[DENYLIST_ENV] ?? '')
    .split(/[\n,]/)
    .map((term) => term.trim())
    .filter(Boolean);
  return terms.length ? terms : undefined;
}

/** Private planning and audit documents, whatever they are called next time. */
const PRIVATE_DOC = /(^|\/)(plan|roadmap|privacy-audit|audit)[^/]*\.md$/i;
const TEXT =
  /\.(md|ts|tsx|mts|mjs|js|json|ya?ml|txt|snap|html|css|sh)$|(^|\/)\.[\w.-]+$|(^|\/)(LICENSE|NOTICE)$/;

/** Lowercase entries match in any case; an entry with an uppercase letter matches as written. */
const matcher = (term) =>
  term === term.toLowerCase()
    ? (text) => text.toLowerCase().includes(term)
    : (text) => text.includes(term);

/**
 * Everything wrong with the tracked files of `root`, as sentences. A denylist hit names the
 * file and the identifier, never the line: this output ends up in CI logs.
 */
export function problems(root, terms = denylist(), files = trackedFiles(root)) {
  const found = [];
  const matchers = (terms ?? []).map((term) => [term, matcher(term)]);
  for (const path of files) {
    if (PRIVATE_DOC.test(path))
      found.push(`${path}: a private planning or audit document does not belong here`);
    for (const [term, matches] of matchers)
      if (matches(path)) found.push(`${path}: the path contains the private identifier "${term}"`);
    const file = join(root, path);
    if (!TEXT.test(path) || !existsSync(file)) continue;
    const text = readFileSync(file, 'utf8');
    for (const [term, matches] of matchers)
      if (matches(text)) found.push(`${path}: contains the private identifier "${term}"`);
  }
  return found;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const root = resolve(args.find((a) => !a.startsWith('--')) ?? '.');
  const terms = denylist();
  if (!terms && args.includes('--require-denylist')) {
    console.error(`no denylist: set ${DENYLIST_ENV} (comma or newline separated)`);
    process.exit(2);
  }
  const list = args.includes('--every-file') ? everyFile(root) : trackedFiles(root);
  const found = problems(root, terms, list);
  const files = list.length;
  if (args.includes('--json')) {
    console.log(JSON.stringify({ files, denylist: terms?.length, problems: found }));
  } else {
    const scope = terms ? `${terms.length} private identifiers` : 'no denylist given';
    console.log(
      `${root}: ${files} ${args.includes('--every-file') ? '' : 'tracked '}files, ${scope}`,
    );
    for (const line of found) console.log(`  ✗ ${line}`);
    console.log(found.length ? `${found.length} problems` : 'clean');
  }
  process.exit(found.length ? 1 : 0);
}
