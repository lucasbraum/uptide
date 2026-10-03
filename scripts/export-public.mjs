// The public tree as an export: one ref of this repository, minus the excluded paths, in a
// new directory with a fresh git repository and a single commit. Nothing is pushed and no
// repository is created: the script ends by printing the commands for the owner to run.
//
//   node scripts/export-public.mjs <new-directory> [--ref main]
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { denylist, exclusions, problems, publicFiles } from './public-tree.mjs';

const COMMIT = 'Initial public release';

const args = process.argv.slice(2);
const refAt = args.indexOf('--ref');
const ref = refAt >= 0 ? args[refAt + 1] : 'main';
const target = args.find((a, i) => !a.startsWith('--') && (refAt < 0 || i !== refAt + 1));
const fail = (message) => {
  console.error(`error: ${message}`);
  process.exit(2);
};
const git = (cwd, ...rest) => execFileSync('git', rest, { cwd, encoding: 'utf8' }).trim();

if (!target || !ref) fail('usage: node scripts/export-public.mjs <new-directory> [--ref main]');
const source = realpathSync(git(process.cwd(), 'rev-parse', '--show-toplevel'));
/** Symlinks resolved up to the part that does not exist yet (`/var` is `/private/var` on macOS). */
const real = (path) =>
  existsSync(path) ? realpathSync(path) : join(real(dirname(path)), basename(path));
const out = real(resolve(target));
if (!relative(source, out).startsWith('..'))
  fail(`${out} is inside this repository; export next to it`);
if (existsSync(out) && readdirSync(out).length > 0) fail(`${out} exists and is not empty`);
const terms = denylist(source);
if (!terms) fail('no denylist: an export is never produced without checking it against one');
const commit = git(source, 'rev-parse', '--verify', `${ref}^{commit}`);

// The committed tree of the ref, never the working directory: nothing untracked or
// half-edited can leak into the export.
mkdirSync(out, { recursive: true });
const archive = execFileSync('git', ['archive', '--format=tar', commit], {
  cwd: source,
  maxBuffer: 1024 * 1024 * 1024,
});
execFileSync('tar', ['-x', '-C', out], { input: archive });

const excluded = exclusions(out);
for (const entry of excluded) {
  const path = resolve(out, entry);
  // Only ever inside the export: an entry cannot climb out of it.
  if (!relative(out, path).startsWith('..')) rmSync(path, { recursive: true, force: true });
}

git(out, 'init', '-q', '-b', 'main');
git(out, 'add', '-A');
git(out, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', COMMIT);

const found = problems(out, terms);
const files = publicFiles(out).length;
console.log(`exported ${ref} (${commit.slice(0, 7)}) to ${out}`);
console.log(`  ${files} files, ${excluded.length} excluded paths, 1 commit: "${COMMIT}"`);
console.log(
  `  denylist (${terms.length} private identifiers): ${found.length ? 'FAILED' : 'clean'}`,
);
for (const line of found) console.log(`    ✗ ${line}`);
if (found.length) {
  console.log('\nNot publishable. Fix the source, delete the directory and export again.');
  process.exit(1);
}

const url = JSON.parse(readFileSync(join(out, 'packages/cli/package.json'), 'utf8')).repository.url;
const slug = /github\.com\/([^/]+\/[^/.]+)/.exec(url)?.[1] ?? 'OWNER/REPO';
let origin = '';
try {
  origin = git(source, 'remote', 'get-url', 'origin');
} catch {
  // no origin: nothing to move out of the way
}
const sourceSlug = /github\.com[:/]([^/]+\/[^/.]+)/.exec(origin)?.[1];
console.log('\nNothing was created or pushed. To publish, run these yourself:\n');
if (sourceSlug === slug) {
  const [owner, name] = slug.split('/');
  console.log(`  # 1. The public repository takes the name the package points at (${slug}),`);
  console.log('  #    so the private one moves out of the way first and stays private.');
  console.log(`  gh repo rename ${name}-archive --repo ${slug} --yes`);
  console.log(
    '  # 2. Point every private checkout at the new name BEFORE step 3. After step 3 the',
  );
  console.log(
    '  #    old URL is the public repository: a push from a private checkout would go there.',
  );
  console.log(
    `  git -C ${source} remote set-url origin https://github.com/${owner}/${name}-archive.git`,
  );
  console.log('  # 3. Create the public repository from the export and push its single commit.');
} else {
  console.log('  # Create the public repository from the export and push its single commit.');
}
console.log(`  gh repo create ${slug} --public --source ${out} --remote origin --push`);
