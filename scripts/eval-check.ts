/**
 * Milestone 2 evaluation on a real repository: `uptide check` plus timing per package
 * and per signal, so precision and speed can be judged on real codebases.
 *
 *   pnpm eval:check <repo-dir> [--only=<pkg>,<pkg>] [--target=<pkg>@<ver>] [--no-compile] [--json] [--warm] [--concurrency=N (default 1, so per-phase times are real)] [--workspaces=N (workers, default 2)] [--truth=<fixtures/truth/x.json>]
 *
 * `--warm` runs the check a second time so the cost of a warm surface and tarball cache shows next to the first run.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { check, formatTruthTable, scoreAgainstTruth, type TruthCase } from '@uptide/core';
import { formatCheck } from '../packages/cli/src/format-check.ts';

const args = process.argv.slice(2);
const repoDir = resolve(args.find((a) => !a.startsWith('--')) ?? '.');
const onlyFlag = args.find((a) => a.startsWith('--only='));
const targets: Record<string, string> = {};
for (const flag of args.filter((a) => a.startsWith('--target='))) {
  const spec = flag.slice('--target='.length);
  const at = spec.lastIndexOf('@');
  if (at > 0) targets[spec.slice(0, at)] = spec.slice(at + 1);
}

const options = {
  cwd: repoDir,
  only: onlyFlag ? onlyFlag.slice('--only='.length).split(',') : undefined,
  targets,
  compile: !args.includes('--no-compile'),
  // One package at a time by default: the phases are CPU-bound on one thread, and interleaved
  // packages would bill each other's work to whichever phase happened to be awaiting.
  concurrency: Number(
    args.find((a) => a.startsWith('--concurrency='))?.slice('--concurrency='.length) ?? 1,
  ),
  workspaceConcurrency: Number(
    args.find((a) => a.startsWith('--workspaces='))?.slice('--workspaces='.length) ?? 2,
  ),
};
const report = await check(options);
const warm = args.includes('--warm') ? await check(options) : undefined;
if (args.includes('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  process.stdout.write(formatCheck(report, { color: process.stdout.isTTY }));
  const analyzed = report.packages.filter(
    (p) =>
      ['breaking', 'deprecated', 'safe', 'partial', 'unknown'].includes(p.status) &&
      !p.notes.includes('up to date'),
  );
  const byReason: Record<string, number> = {};
  const reasonOf = (p: (typeof report.packages)[number]): string => {
    switch (p.status) {
      case 'workspace':
        return 'workspace link, nothing to upgrade';
      case 'private':
        return `private: ${p.notes[0] ?? 'registry'}`;
      case 'safe':
        return 'up to date';
      case 'no-types':
        return p.notes.find((n) => n.startsWith('types in ')) ?? 'no type declarations';
      case 'not-imported':
        return p.notes.includes('no usages found')
          ? 'imported but never used'
          : (p.notes.find((n) => n.includes('skipped')) ?? 'never imported');
      default:
        return `skipped: ${p.notes.find((n) => !n.includes('not analyzed')) ?? p.status}`;
    }
  };
  for (const p of report.packages) {
    if (analyzed.includes(p)) continue;
    const reason = reasonOf(p);
    byReason[reason] = (byReason[reason] ?? 0) + 1;
  }
  const sum = (k: keyof (typeof report.packages)[number]['timing']): number =>
    report.packages.reduce((n, p) => n + (p.timing[k] ?? 0), 0);
  console.log('run:');
  console.log(`  dependencies considered ${report.packages.length}, analyzed ${analyzed.length}`);
  for (const [reason, n] of Object.entries(byReason)) console.log(`  skipped ${n}: ${reason}`);
  console.log(
    `  time per phase (summed over packages): fetch ${sum('fetchMs')}ms, diff ${sum('diffMs')}ms, signal A ${sum('usagesMs')}ms, signal B ${sum('compileMs')}ms, signal C ${sum('runtimeMs')}ms`,
  );
  console.log(`  workspaces ${report.workspaces.length}: ${report.workspaces.join(', ')}`);
  console.log(
    `  total ${report.timing.totalMs}ms wall clock (first run)${warm ? `, ${warm.timing.totalMs}ms warm (second run)` : ''}`,
  );
  const truthFlag = args.find((a) => a.startsWith('--truth='));
  if (truthFlag) {
    const truth = JSON.parse(readFileSync(truthFlag.slice('--truth='.length), 'utf8')) as {
      cases: TruthCase[];
    };
    console.log('against ground truth:');
    console.log(formatTruthTable(scoreAgainstTruth(report, truth.cases)));
  }
  console.log(warm ? 'per package (warm run):' : 'per package:');
  const table = warm
    ? warm.packages.filter((p) =>
        analyzed.some((a) => a.workspace === p.workspace && a.name === p.name),
      )
    : analyzed;
  for (const p of table) {
    const t = p.timing;
    console.log(
      `  ${`${p.workspace === '.' ? '' : `${p.workspace} `}${p.name}`.padEnd(40)} fetch ${String(t.fetchMs).padStart(5)}ms  diff ${String(t.diffMs).padStart(5)}ms  A ${String(t.usagesMs).padStart(5)}ms  B ${String(t.compileMs).padStart(5)}ms  C ${String(t.runtimeMs ?? 0).padStart(5)}ms   ${p.callSitesChecked} call sites, ${p.findings.length} findings`,
    );
  }
}
