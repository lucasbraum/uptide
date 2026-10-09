/**
 * The "Verified packs" table in README.md, generated from each registered pack: its
 * metadata, its ground truth and what `uptide pack test --write` recorded in
 * verification.json. The table sits between `<!-- packs:start -->` and `<!-- packs:end -->`.
 *
 *   pnpm docs:packs            rewrite the table
 *   pnpm docs:packs --check    exit 1 when the table is stale (CI)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registeredPacks } from '../packages/core/src/packs/index.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const README = join(root, 'README.md');
const START = '<!-- packs:start -->';
const END = '<!-- packs:end -->';

interface GroundTruth {
  repos: { repo?: string; fixture?: string }[];
}

/** `>=3 <4` reads as `3.x`; a floor alone (`>=14`) as `14 and newer`; anything else verbatim. */
function rangeLabel(range: string): string {
  const bounded = /^>=(\d+) <(\d+)$/.exec(range);
  if (bounded && Number(bounded[2]) === Number(bounded[1]) + 1) return `${bounded[1]}.x`;
  const floor = /^>=(\d+)$/.exec(range);
  if (floor) return `${floor[1]} and newer`;
  return range;
}

const percent = (n: number): string => `${Math.round(n * 100)}%`;

export function packsTable(): string {
  const rows = registeredPacks().map(({ dir, pack, verification }) => {
    const truth = JSON.parse(
      readFileSync(join(root, 'packages/core/src/packs', dir, 'ground-truth.json'), 'utf8'),
    ) as GroundTruth;
    const repos = truth.repos.filter((r) => r.repo).map((r) => r.repo as string);
    const range =
      pack.meta.from === pack.meta.to
        ? rangeLabel(pack.meta.from)
        : `${rangeLabel(pack.meta.from)} → ${rangeLabel(pack.meta.to)}`;
    return `| \`${pack.meta.package}\` | ${range} | ${percent(verification.breaking.precision)} | ${percent(verification.breaking.recall)} | ${repos.join(', ')} | ${verification.status} |`;
  });
  return [
    '| Package | Range | Precision | Recall | Ground-truth repositories | Status |',
    '| --- | --- | ---: | ---: | --- | --- |',
    ...rows,
  ].join('\n');
}

function main(): void {
  const check = process.argv.includes('--check');
  const readme = readFileSync(README, 'utf8');
  const start = readme.indexOf(START);
  const end = readme.indexOf(END);
  if (start < 0 || end < 0 || end < start)
    throw new Error(`README.md: expected ${START} … ${END} around the packs table`);
  const next = `${readme.slice(0, start + START.length)}\n${packsTable()}\n${readme.slice(end)}`;
  if (next === readme) {
    console.log('README.md: the packs table is current');
    return;
  }
  if (check) {
    console.error('README.md: the packs table is stale; run `pnpm docs:packs` and commit');
    process.exit(1);
  }
  writeFileSync(README, next);
  console.log('README.md: packs table rewritten');
}

main();
