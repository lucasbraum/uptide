// What a run of the Release workflow does (.github/workflows/release.yml), as GitHub
// Actions outputs: `pending` (changesets wait to be versioned), `version` (the committed
// CLI version) and `channel` (`latest`, `next` or empty for nothing to publish).
//
//   EVENT=push|workflow_dispatch node scripts/release-plan.mjs >> "$GITHUB_OUTPUT"
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * On a push, pending changesets mean a Version Packages pull request and a `next` snapshot;
 * with none, a committed version npm does not have goes to `latest`. By hand, only that
 * last part, whatever is pending: it is for an automatic publish that failed.
 */
export function releasePlan({ event, pending, version, published }) {
  const channel =
    event === 'push' && pending ? 'next' : !published.includes(version) ? 'latest' : '';
  return { pending, version, channel };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const pending = readdirSync(`${root}.changeset`).some(
    (file) => file.endsWith('.md') && file !== 'README.md',
  );
  const { version } = JSON.parse(readFileSync(`${root}packages/cli/package.json`, 'utf8'));
  // A registry error fails the run: guessing "unpublished" would only fail later, at publish.
  const published = JSON.parse(
    execFileSync('npm', ['view', 'uptide', 'versions', '--json'], { encoding: 'utf8' }),
  );
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: this standalone CI step runs outside Turbo.
  const plan = releasePlan({ event: process.env.EVENT, pending, version, published });
  for (const [key, value] of Object.entries(plan)) console.log(`${key}=${value}`);
  console.error(
    plan.channel
      ? `uptide@${version}: publish under ${plan.channel}${pending ? ' (changesets pending)' : ''}`
      : `uptide@${version} is on npm${pending ? '; changesets pending' : ''}: nothing to publish`,
  );
}
