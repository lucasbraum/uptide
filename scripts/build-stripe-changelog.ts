/** Explicit maintenance command; the migration pack never downloads changelog data. */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { parseChangelog } from '../packages/core/src/packs/stripe/changelog.ts';

import { entryTouches } from '../packages/core/src/packs/stripe/relevance.ts';

const source = 'https://docs.stripe.com/changelog.md';
const response = await fetch(source);
if (!response.ok) throw new Error(`Stripe changelog: HTTP ${response.status}`);
const markdown = await response.text();
const parsed = parseChangelog(markdown);
const data = {
  schema: 1,
  source,
  sha256: createHash('sha256').update(markdown).digest('hex'),
  generatedAt: new Date().toISOString(),
  ...parsed,
  entries: parsed.entries.map((e) => ({ ...e, touches: entryTouches(e) })),
};
writeFileSync(
  new URL('../packages/core/src/packs/stripe/changelog.v1.json', import.meta.url),
  `${JSON.stringify(data, null, 2)}\n`,
);
console.log(
  `${data.versions.length} releases, ${data.entries.length} entries; SHA256 ${data.sha256}`,
);
