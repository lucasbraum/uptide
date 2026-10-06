// How CI scans for private material (scripts/public-tree.mjs) on this event. The denylist
// is a secret: required on pushes and on pull requests from this repository. A fork has no
// secrets, so only document names are checked there. Dependabot's own pull requests get no
// repository secrets either, and are never given this one (CONTRIBUTING.md): with the
// opener GitHub records as dependabot[bot] and no denylist, the identifier scan is skipped
// with a notice, and whatever it brings is scanned with the secret on its push to main.
// Every other opener, the release app included (its pull requests get secrets), is scanned
// in full, and a missing denylist fails.
//
//   EVENT, HEAD_REPO, REPO, PR_AUTHOR, UPTIDE_PRIVATE_DENYLIST  node scripts/private-material.mjs
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEPENDABOT } from './bots.mjs';
import { DENYLIST_ENV } from './public-tree.mjs';

/** The public-tree arguments for this event, and the notice to print when it skips a part. */
export function scanFor({ event, headRepo, repo, prAuthor, denylist }) {
  if (event === 'pull_request' && headRepo !== repo) return { args: ['.'] };
  if (event === 'pull_request' && prAuthor === DEPENDABOT && !denylist)
    return {
      args: ['.'],
      notice:
        'Private identifier scan skipped: Dependabot pull requests get no repository secrets, and this one is never given to them. Document names are still checked; the merge to main is scanned with the denylist.',
    };
  return { args: ['.', '--require-denylist'] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const env = process.env;
  const { args, notice } = scanFor({
    event: env.EVENT,
    headRepo: env.HEAD_REPO,
    repo: env.REPO,
    prAuthor: env.PR_AUTHOR,
    denylist: env[DENYLIST_ENV],
  });
  if (notice) console.log(`::notice title=No private material::${notice}`);
  const scan = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('./public-tree.mjs', import.meta.url)), ...args],
    { stdio: 'inherit' },
  );
  process.exit(scan.status ?? 1);
}
