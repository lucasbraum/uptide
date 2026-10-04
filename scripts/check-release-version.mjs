import { readFileSync } from 'node:fs';

const { version } = JSON.parse(
  readFileSync(new URL('../packages/cli/package.json', import.meta.url), 'utf8'),
);
// biome-ignore lint/suspicious/noUndeclaredEnvVars: this standalone CI guard runs outside Turbo.
if (process.env.VERSION !== version) {
  console.error(
    `::error::Release version must equal packages/cli/package.json (${version}) at the checked-out ref. Merge the version PR first, then run this workflow with that same version.`,
  );
  process.exit(1);
}
console.log(`Release version matches the committed CLI manifest: ${version}`);
