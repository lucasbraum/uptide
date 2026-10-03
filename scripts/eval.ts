/**
 * Precision measurement for milestone 1. For each real pair in fixtures/pairs.json prints
 * surface sizes, totals per entry point, counts by severity and kind, and the top breaking
 * changes, to compare by hand against the official changelogs.
 *
 *   pnpm eval [name...] [--top=N] [--full] [--root-only]
 *
 * `--full` writes every breaking and deprecated change to `eval-out/<pkg>.json`; `--root-only` counts as
 * genuinely public only what is reachable from the root entry point.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type ApiSurface,
  type Change,
  depthOf,
  diffPackageDetailed,
  foldForDisplay,
  symbolPath,
} from '@uptide/core';

const KIND_ORDER = [
  'signature',
  'narrowed',
  'removed',
  'moved',
  'type',
  'widened',
  'required',
  'renamed',
  'deprecated',
  'added',
];
const VALUE_KINDS = new Set(['function', 'method', 'class', 'variable', 'enum', 'enumMember']);

const pairs = JSON.parse(
  readFileSync(join(import.meta.dirname, '../fixtures/pairs.json'), 'utf8'),
) as {
  name: string;
  from: string;
  to: string;
}[];
const args = process.argv.slice(2);
const only = args.filter((a) => !a.startsWith('--'));
const topFlag = args.find((a) => a.startsWith('--top='));
const top = topFlag ? Number(topFlag.slice('--top='.length)) : 30;
const full = args.includes('--full');
const rootOnly = args.includes('--root-only');
const outDir = join(import.meta.dirname, '../eval-out');

function describe(c: Change): string {
  const arrow =
    c.before !== undefined && c.after !== undefined
      ? `  ${c.before}  ->  ${c.after}`
      : c.before !== undefined
        ? `  was ${c.before}`
        : '';
  const extra = [
    c.replacement ? `${c.kind === 'moved' ? 'now at' : 'replacement'}: ${c.replacement}` : '',
    c.confidence < 1 ? `confidence ${c.confidence}` : '',
    c.notes ?? '',
  ]
    .filter(Boolean)
    .join('; ');
  return `${c.kind.padEnd(10)} ${c.path}${arrow}${extra ? `\n             (${extra})` : ''}`;
}

/** A change is a runtime-value change when its symbol, or the class it belongs to, is a value. */
function isValueChange(c: Change, kinds: Map<string, string>): boolean {
  const kind = kinds.get(c.path);
  if (kind !== undefined && VALUE_KINDS.has(kind)) return true;
  if (kind === 'property') {
    let p = symbolPath.parentOf(c.path);
    while (p !== undefined) {
      const k = kinds.get(p);
      if (k === 'class') return true;
      if (k !== undefined && k !== 'property') return false;
      p = symbolPath.parentOf(p);
    }
  }
  return false;
}

function entriesOf(c: Change, a: ApiSurface, b: ApiSurface): string[] {
  const from = c.kind === 'removed' || c.kind === 'moved' ? a : b;
  return from.symbols.find((s) => s.path === c.path)?.exportedFrom ?? [];
}

for (const pair of pairs) {
  if (only.length > 0 && !only.includes(pair.name)) continue;
  const started = Date.now();
  let changes: Change[];
  let a: ApiSurface;
  let b: ApiSurface;
  try {
    ({ surfaceA: a, surfaceB: b, changes } = await diffPackageDetailed(pair));
  } catch (err) {
    console.log(`\n=== ${pair.name} ${pair.from} -> ${pair.to}: ERROR ${(err as Error).message}\n`);
    continue;
  }
  const kinds = new Map<string, string>();
  for (const s of a.symbols) kinds.set(s.path, s.kind);
  for (const s of b.symbols) kinds.set(s.path, s.kind);
  const entryOf = new Map<Change, string[]>(changes.map((c) => [c, entriesOf(c, a, b)]));

  const by = { breaking: 0, deprecated: 0, additive: 0 };
  const byKind: Record<string, number> = {};
  for (const c of changes) {
    by[c.severity]++;
    byKind[c.kind] = (byKind[c.kind] ?? 0) + 1;
  }
  console.log(
    `\n=== ${pair.name} ${pair.from} -> ${pair.to}  (${((Date.now() - started) / 1000).toFixed(1)}s)`,
  );
  console.log(`symbols: ${a.symbols.length} in ${pair.from}, ${b.symbols.length} in ${pair.to}`);
  console.log(
    `total changes ${changes.length}: breaking ${by.breaking}, deprecated ${by.deprecated}, additive ${by.additive}`,
  );
  console.log(
    `by kind: ${Object.entries(byKind)
      .map(([k, n]) => `${k} ${n}`)
      .join(', ')}`,
  );

  const entryNames = [...new Set([...a.symbols, ...b.symbols].flatMap((s) => s.exportedFrom))].sort(
    (x, y) => (x === '.' ? -1 : y === '.' ? 1 : x < y ? -1 : 1),
  );
  console.log('per entry point:');
  for (const entry of entryNames) {
    const inA = a.symbols.filter((s) => s.exportedFrom.includes(entry)).length;
    const inB = b.symbols.filter((s) => s.exportedFrom.includes(entry)).length;
    const here = changes.filter((c) => entryOf.get(c)?.includes(entry));
    const breakingHere = here.filter((c) => c.severity === 'breaking').length;
    console.log(
      `  ${entry.padEnd(14)} symbols ${inA} -> ${inB}, changes ${here.length} (${breakingHere} breaking)`,
    );
  }

  const breaking = changes.filter((c) => c.severity === 'breaking');
  const folded = foldForDisplay(breaking);
  const { impliedByRemoval, aliasDuplicates, nonPublic } = folded.hidden;
  const lowConfidence = folded.shown.filter((c) => c.confidence < 0.7);
  const notRoot = rootOnly ? folded.shown.filter((c) => !entryOf.get(c)?.includes('.')) : [];
  const genuine = folded.shown.filter((c) => c.confidence >= 0.7 && !notRoot.includes(c));
  console.log(
    `breaking: ${breaking.length} raw -> ${folded.shown.length} shown (${impliedByRemoval.length} implied by a removed parent, ${aliasDuplicates.length} alias duplicates, ${nonPublic.length} protected/@internal)` +
      ` -> ${genuine.length} genuinely public (${lowConfidence.length} confidence < 0.7${rootOnly ? `, ${notRoot.length} not reachable from .` : ''})`,
  );
  const movedAll = changes.filter((c) => c.kind === 'moved');
  const movedTopLevel = movedAll.filter((c) => symbolPath.parentOf(c.path) === undefined);
  console.log(`moved (top-level): ${movedTopLevel.length}`);
  console.log(`moved (including members): ${movedAll.length}`);

  const ranked = [...genuine].sort(
    (x, y) =>
      Number(isValueChange(y, kinds)) - Number(isValueChange(x, kinds)) ||
      depthOf(x.path) - depthOf(y.path) ||
      KIND_ORDER.indexOf(x.kind) - KIND_ORDER.indexOf(y.kind) ||
      (x.path < y.path ? -1 : 1),
  );
  console.log(
    `\ntop ${Math.min(top, ranked.length)} genuinely public breaking (runtime values first, shallow first, then kind):`,
  );
  for (const c of ranked.slice(0, top)) console.log(`  ${describe(c)}`);

  const deprecated = foldForDisplay(changes.filter((c) => c.kind === 'deprecated')).shown.sort(
    (x, y) =>
      Number(isValueChange(y, kinds)) - Number(isValueChange(x, kinds)) ||
      depthOf(x.path) - depthOf(y.path) ||
      (x.path < y.path ? -1 : 1),
  );
  const firstLine = (text: string | undefined): string => (text ?? '').split('\n')[0] ?? '';
  if (deprecated.length === 0) console.log('\ndeprecated: none');
  else console.log(`\ntop ${Math.min(15, deprecated.length)} deprecated (runtime values first):`);
  for (const c of deprecated.slice(0, 15))
    console.log(`  ${c.path.padEnd(32)} ${firstLine(c.notes) || '(no message)'}`);

  if (full) {
    // Breaking and deprecated: what a changelog comparison needs. Additive is noise there.
    const dump = changes.filter((c) => c.severity !== 'additive');
    mkdirSync(outDir, { recursive: true });
    const file = join(outDir, `${pair.name.replace('/', '__')}.json`);
    writeFileSync(file, `${JSON.stringify(dump, null, 2)}\n`);
    console.log(`\nwrote ${dump.length} breaking + deprecated changes to ${file}`);
  }
}
