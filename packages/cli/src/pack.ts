import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { PackTestReport, RegisteredPack, Tally } from '@uptide/core';
import pc from 'picocolors';
import { CliError } from './errors.js';

/** The uptide checkout `cwd` is in: packs are contributor work, done in the source tree. */
export function packRoot(cwd: string): string {
  let dir = cwd;
  for (;;) {
    if (existsSync(join(dir, 'packages', 'core', 'src', 'packs', 'registry.ts'))) return dir;
    const parent = dirname(dir);
    if (parent === dir)
      throw new CliError('uptide pack works inside an uptide checkout', {
        why: 'packs live in packages/core/src/packs of https://github.com/uptide-dev/uptide',
        next: 'git clone https://github.com/uptide-dev/uptide && cd uptide && pnpm install',
      });
    dir = parent;
  }
}

/**
 * The packs to test: what this build carries, checked against the checkout's registry. A pack
 * added or edited since the build would be tested as it was, so a missing one is an error.
 */
export function packsToTest(
  root: string,
  registered: readonly RegisteredPack[],
  name: string | undefined,
): RegisteredPack[] {
  const onDisk = [
    ...readFileSync(join(root, 'packages', 'core', 'src', 'packs', 'registry.ts'), 'utf8').matchAll(
      /\{ dir: '([^']+)'/g,
    ),
  ].map((m) => m[1] as string);
  const missing = onDisk.filter((dir) => !registered.some((e) => e.dir === dir));
  if (missing.length > 0)
    throw new CliError(`this build of uptide does not include the pack in ${missing.join(', ')}`, {
      why: 'pack test runs the packs compiled into the CLI; `pnpm uptide` runs them from source',
      next: `pnpm uptide pack test${name ? ` ${name}` : ''}`,
    });
  if (!name) return [...registered];
  const entry = registered.find((e) => e.pack.name === name || e.dir === name);
  if (!entry)
    throw new CliError(`no pack for ${name}`, {
      next: `uptide pack new ${name} --from <range> --to <range>`,
    });
  return [entry];
}

const pct = (n: number): string => `${Math.round(n * 100)}%`;

function row(name: string, t: Tally): string {
  return `  ${name.padEnd(28)} ${pct(t.precision).padStart(9)} ${pct(t.recall).padStart(7)} ${String(t.truePositives).padStart(5)} ${String(t.falsePositives).padStart(4)} ${String(t.falseNegatives).padStart(4)}`;
}

/** What `uptide pack test` prints for one pack. */
export function formatPackTest(report: PackTestReport, color = false): string {
  const c = pc.createColors(color);
  const out: string[] = [];
  const recorded = report.recorded === report.status ? '' : `, recorded ${report.recorded}`;
  out.push(c.bold(`uptide pack test ${report.package} · ${report.status}${recorded}`));
  for (const problem of report.problems) out.push(`  ${c.red('✗')} ${problem}`);

  const f = report.fixtures;
  const fixtureSites = Object.values(f.rules).reduce(
    (n, t) => n + t.truePositives + t.falseNegatives,
    0,
  );
  const fixturesOk =
    f.rewriteFailures.length + f.falsePositives.length + f.falseNegatives.length === 0 &&
    f.unknown.length === 0;
  out.push(
    `fixtures      ${f.cases.length} case${f.cases.length === 1 ? '' : 's'}, ${fixtureSites} site${fixtureSites === 1 ? '' : 's'} · ${fixturesOk ? c.green('pass') : c.red('fail')}`,
  );
  for (const u of f.unknown)
    out.push(`  ${c.red('✗')} ${u.file}:${u.line} names no rule: ${u.rule}`);
  for (const r of f.rewriteFailures)
    out.push(`  ${c.red('✗')} ${r.file}${r.line ? `:${r.line}` : ''} ${r.message}`);
  for (const s of f.falsePositives)
    out.push(`  ${c.red('✗')} ${s.file}:${s.line} ${s.rule} detected, not marked`);
  for (const s of f.falseNegatives)
    out.push(`  ${c.red('✗')} ${s.file}:${s.line} ${s.rule} marked, not detected`);

  if (report.fixturesOnly) out.push('ground truth  skipped (--fixtures-only)');
  else if (report.repos.length === 0)
    out.push('ground truth  no repository yet: the pack ships as a candidate');
  else {
    out.push('ground truth');
    for (const r of report.repos) {
      const head = `  ${r.label.padEnd(44)} ${report.package} ${r.from} → ${r.to}`;
      if (r.error) {
        out.push(`${head}  ${c.red(`error: ${r.error}`)}`);
        continue;
      }
      out.push(
        `${head}  predicted ${r.predicted.length}, expected ${r.expected.length}, false positives ${r.falsePositives.length}, false negatives ${r.falseNegatives.length}`,
      );
      if (r.installedMismatch) out.push(`    ${c.yellow('!')} ${r.installedMismatch}`);
      if (r.companions?.length)
        out.push(`    with ${r.companions.map((m) => `${m.name} ${m.from} → ${m.to}`).join(', ')}`);
      for (const left of r.leftBehind ?? []) out.push(`    ${c.red('✗')} ${left}`);
    }
    out.push('');
    out.push(
      `  ${'rule'.padEnd(28)} ${'precision'.padStart(9)} ${'recall'.padStart(7)} ${'tp'.padStart(5)} ${'fp'.padStart(4)} ${'fn'.padStart(4)}`,
    );
    for (const [rule, t] of Object.entries(report.rules).sort(([a], [b]) => a.localeCompare(b)))
      out.push(row(rule, t));
    out.push(row('overall (sites)', report.overall));
    out.push(c.bold(row('breaking (sites)', report.breaking)));
    const listed = (
      title: string,
      sites: { label: string; file: string; line: number; text: string }[],
    ) => {
      if (sites.length === 0) return;
      out.push('');
      out.push(`${title} (${sites.length})`);
      for (const s of sites) out.push(`  ${s.label}  ${s.file}:${s.line}  ${s.text}`);
    };
    listed(
      'false positives',
      report.repos.flatMap((r) =>
        r.falsePositives.map((s) => ({
          label: r.label,
          file: s.file,
          line: s.line,
          text: `${s.rule} (${s.severity ?? 'breaking'})`,
        })),
      ),
    );
    listed(
      'false negatives',
      report.repos.flatMap((r) =>
        r.falseNegatives.map((s) => ({ label: r.label, file: s.file, line: s.line, text: s.rule })),
      ),
    );
    listed(
      'reported under another rule',
      report.repos.flatMap((r) =>
        r.wrongRule.map((s) => ({
          label: r.label,
          file: s.file,
          line: s.line,
          text: `${s.rule}, expected ${s.expected}`,
        })),
      ),
    );
  }
  out.push('');
  if (report.stale)
    out.push(
      `${c.red('✗')} verification.json does not match this run: \`uptide pack test ${report.package} --write\` records it`,
    );
  const breakingFp = report.breaking.falsePositives;
  out.push(
    report.passed
      ? c.green(`PASS ${report.package}: ${report.status}`)
      : c.red(
          `FAIL ${report.package}${breakingFp ? `: ${breakingFp} false positive${breakingFp === 1 ? '' : 's'} among breaking findings` : ''}`,
        ),
  );
  return `${out.join('\n')}\n`;
}
