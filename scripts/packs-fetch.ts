/**
 * Fetch and cache every public repository the packs' ground truth names, and the corpus
 * (fixtures/corpus.json): a shallow fetch of the pinned commit, dependencies installed with
 * lifecycle scripts off. After this, `uptide pack test --offline` needs no network for them.
 *
 *   pnpm packs:fetch [pack...] [--corpus] [--no-install]
 *
 * The cache is ~/.cache/uptide/ground-truth (UPTIDE_GROUND_TRUTH_CACHE overrides it); CI keeps
 * it between runs keyed on the ground-truth files.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureRepo, type PinnedRepo, registeredPacks, truthCacheDir } from '@uptide/core';

const args = process.argv.slice(2);
const names = args.filter((a) => !a.startsWith('--'));
const install = !args.includes('--no-install');
const root = join(import.meta.dirname, '..');

const wanted: { repo: PinnedRepo; for: string }[] = [];
for (const entry of registeredPacks()) {
  if (names.length && !names.includes(entry.pack.name) && !names.includes(entry.dir)) continue;
  const truth = JSON.parse(
    readFileSync(join(root, 'packages/core/src/packs', entry.dir, 'ground-truth.json'), 'utf8'),
  ) as { repos: { repo?: string; commit?: string }[] };
  for (const r of truth.repos)
    if (r.repo && r.commit)
      wanted.push({ repo: { repo: r.repo, commit: r.commit }, for: entry.pack.name });
}
if (args.includes('--corpus'))
  for (const r of JSON.parse(
    readFileSync(join(root, 'fixtures/corpus.json'), 'utf8'),
  ) as PinnedRepo[])
    wanted.push({ repo: { repo: r.repo, commit: r.commit }, for: 'corpus' });

console.log(`cache: ${truthCacheDir()}`);
let failed = 0;
for (const w of wanted) {
  try {
    const dir = await ensureRepo(w.repo, { install, log: (line) => console.log(`  ${line}`) });
    console.log(`✓ ${w.repo.repo}@${w.repo.commit.slice(0, 12)} (${w.for}) ${dir}`);
  } catch (err) {
    failed++;
    console.log(
      `✗ ${w.repo.repo}@${w.repo.commit.slice(0, 12)} (${w.for}) ${(err as Error).message}`,
    );
  }
}
process.exit(failed ? 1 : 0);
