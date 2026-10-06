// What a release tarball must be before it is published, checked on the tarball itself:
// the legal assets travel with it, the manifest points at this repository (npm provenance
// refuses a mismatch) and carries the version being released, and no file in it holds
// private material (scripts/public-tree.mjs, with the denylist required).
//
//   VERSION=x.y.z UPTIDE_PRIVATE_DENYLIST=... node scripts/check-pack.mjs <uptide-x.y.z.tgz>
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DENYLIST_ENV, denylist, everyFile, problems } from './public-tree.mjs';

export const REPOSITORY = 'git+https://github.com/uptide-dev/uptide.git';
export const LEGAL = ['LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES'];

/** Everything wrong with an unpacked tarball (`dir` holds its `package/`), as sentences. */
export function packProblems(dir, { version, terms }) {
  const root = join(dir, 'package');
  const found = [];
  for (const file of LEGAL) if (!existsSync(join(root, file))) found.push(`${file} is missing`);
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (manifest.name !== 'uptide') found.push(`the package is named ${manifest.name}, not uptide`);
  if (version && manifest.version !== version)
    found.push(`the package is version ${manifest.version}, not ${version}`);
  if (manifest.repository?.url !== REPOSITORY)
    found.push(`repository.url is ${manifest.repository?.url}, not ${REPOSITORY}`);
  if (!terms) found.push(`no denylist: set ${DENYLIST_ENV}`);
  else found.push(...problems(root, terms, everyFile(root)));
  return found;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const tarball = process.argv[2];
  if (!tarball) {
    console.error('usage: node scripts/check-pack.mjs <tarball>');
    process.exit(2);
  }
  const dir = mkdtempSync(join(tmpdir(), 'uptide-pack-'));
  try {
    execFileSync('tar', ['-xzf', resolve(tarball), '-C', dir]);
    // biome-ignore lint/suspicious/noUndeclaredEnvVars: this standalone CI check runs outside Turbo.
    const found = packProblems(dir, { version: process.env.VERSION, terms: denylist() });
    for (const line of found) console.error(`::error::${tarball}: ${line}`);
    if (found.length) process.exit(1);
    console.log(`${tarball}: ${LEGAL.join(', ')}, repository, version and private material ok`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
