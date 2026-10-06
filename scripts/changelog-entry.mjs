// The CHANGELOG entry of one version, for its GitHub Release notes.
//
//   node scripts/changelog-entry.mjs <version> [packages/cli/CHANGELOG.md]
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The body under `## <version>`, up to the next version heading; undefined when absent. */
export function changelogEntry(text, version) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.trim() === `## ${version}`);
  if (start === -1) return undefined;
  const end = lines.findIndex((line, i) => i > start && /^## /.test(line));
  const body = lines
    .slice(start + 1, end === -1 ? undefined : end)
    .join('\n')
    .trim();
  return body || undefined;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [version, file = 'packages/cli/CHANGELOG.md'] = process.argv.slice(2);
  const entry = version && changelogEntry(readFileSync(file, 'utf8'), version);
  if (!entry) {
    console.error(`::error::${file} has no entry for ${version}`);
    process.exit(1);
  }
  console.log(entry);
}
