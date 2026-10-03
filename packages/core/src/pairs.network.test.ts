import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { diffPackage } from './diff-package.js';
import type { Change } from './domain/change.js';

/**
 * Real package pairs, downloaded once and cached. Off by default so the ordinary test
 * run never touches the network; `UPTIDE_NETWORK=1 pnpm test` turns it on.
 */
const ROOT = resolve(import.meta.dirname, '../../..');
const pairs = JSON.parse(readFileSync(join(ROOT, 'fixtures/pairs.json'), 'utf8')) as {
  name: string;
  from: string;
  to: string;
}[];

/**
 * Full Change[] for these pairs runs to tens of megabytes (openai alone is 11MB), so the
 * snapshot is a digest: counts plus one line per breaking change. Enough to catch a
 * regression in extraction or classification; `pnpm eval` prints the detail.
 */
function digest(changes: Change[]): string {
  const bySeverity: Record<string, number> = {};
  const byKind: Record<string, number> = {};
  for (const c of changes) {
    bySeverity[c.severity] = (bySeverity[c.severity] ?? 0) + 1;
    byKind[c.kind] = (byKind[c.kind] ?? 0) + 1;
  }
  const breaking = changes
    .filter((c) => c.severity === 'breaking')
    .map(
      (c) =>
        `${c.kind} ${c.path}${c.replacement ? ` -> ${c.replacement}` : ''}${c.confidence < 1 ? ` @${c.confidence}` : ''}`,
    );
  return JSON.stringify({ total: changes.length, bySeverity, byKind, breaking }, null, 2);
}

describe.skipIf(!process.env.UPTIDE_NETWORK)('real package pairs', () => {
  for (const pair of pairs) {
    it(`${pair.name} ${pair.from} -> ${pair.to}`, { timeout: 300_000 }, async () => {
      const changes = await diffPackage(pair);
      const file = join(
        ROOT,
        'fixtures/snapshots',
        `${pair.name.replace('/', '__')}@${pair.from}..${pair.to}.json`,
      );
      await expect(digest(changes)).toMatchFileSnapshot(file);
    });
  }
});

describe.skipIf(!process.env.UPTIDE_NETWORK)('regressions on real pairs', () => {
  it('zod 3.25.76 -> 4.0.0 does not report members declared on mixins as removed', {
    timeout: 300_000,
  }, async () => {
    const changes = await diffPackage({ name: 'zod', from: '3.25.76', to: '4.0.0' });
    const removed = new Set(changes.filter((c) => c.kind === 'removed').map((c) => c.path));
    for (const path of [
      'ZodString#min',
      'ZodString#max',
      'ZodString#trim',
      'ZodNumber#int',
      'ZodError#issues',
    ]) {
      expect(removed.has(path), `${path} reported removed`).toBe(false);
    }
  });
});
