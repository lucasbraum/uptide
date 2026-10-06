// A pull request that changes what is published (packages/**) says how in a changeset, or
// carries the `no-changeset` label. Dependabot and the release app (whose Version Packages
// pull request consumes the changesets) are exempt, by the opener GitHub records.
//
//   PR_AUTHOR=<login> LABELS='["…"]' node scripts/changeset-required.mjs <base-ref> <head-ref>
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEPENDABOT, RELEASE_BOT } from './bots.mjs';

export const LABEL = 'no-changeset';
const CHANGESET = /^\.changeset\/(?!README\.md$)[^/]+\.md$/;

/** `files`: `{ status, path }` from `git diff --name-status` (A, M, D, R…). */
export function changesetVerdict({ files, labels = [], author }) {
  if (author === DEPENDABOT || author === RELEASE_BOT)
    return { ok: true, reason: `opened by ${author}: exempt` };
  if (!files.some((f) => f.path.startsWith('packages/')))
    return { ok: true, reason: 'nothing under packages/ changed' };
  if (files.some((f) => f.status !== 'D' && CHANGESET.test(f.path)))
    return { ok: true, reason: 'has a changeset' };
  if (labels.includes(LABEL)) return { ok: true, reason: `labelled ${LABEL}` };
  return {
    ok: false,
    reason: `packages/ changed without a changeset: run \`pnpm changeset\` and commit the file, or add the \`${LABEL}\` label when nothing user-visible changed`,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [base, head] = process.argv.slice(2);
  // Renames print the new path last; the status letter's first character is enough.
  const files = execFileSync(
    'git',
    ['diff', '--name-status', '--no-renames', `${base}...${head}`],
    {
      encoding: 'utf8',
    },
  )
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [status, path] = line.split('\t');
      return { status: status[0], path };
    });
  const { LABELS, PR_AUTHOR } = process.env;
  const verdict = changesetVerdict({
    files,
    labels: JSON.parse(LABELS || '[]'),
    author: PR_AUTHOR,
  });
  console.log(verdict.ok ? `ok: ${verdict.reason}` : `::error title=Changeset::${verdict.reason}`);
  process.exit(verdict.ok ? 0 : 1);
}
