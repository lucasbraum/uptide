import type { ListReport } from '@uptide/core';
import { type CheckHeader, repoLine } from './format-check.js';
import { elapsed } from './progress.js';

export function formatList(
  report: ListReport,
  opts: { all?: boolean; header?: CheckHeader; invocation?: string; cwd?: string } = {},
): string {
  const command = opts.invocation ?? 'npx uptide';
  const lines = [
    `uptide list${opts.header ? ` · ${repoLine(opts.header)} · ${elapsed(opts.header.ms)}` : ''}`,
    '',
  ];
  const used = report.packages.filter((p) => p.usage.files > 0);
  const unused = report.packages.filter((p) => p.usage.files === 0);
  const row = (p: ListReport['packages'][number]): string =>
    `${p.name}  ${p.current} → ${p.latest}  ${p.change} · ${p.tier} · ${p.usage.files} files, ${p.usage.callSites} call sites · ${p.workspaces.join(', ')}${p.usage.topSymbols.length ? `\n  top symbols: ${p.usage.topSymbols.map((s) => `${s.name} (${s.count})`).join(', ')}` : ''}`;
  for (const p of used.filter((p) => opts.all || p.change === 'major')) lines.push(row(p));
  const collapsed = used.filter((p) => p.change !== 'major');
  if (!opts.all && collapsed.length)
    lines.push(
      `${collapsed.length} minor/patch upgrades (${collapsed.map((p) => p.name).join(', ')}) · --all to expand`,
    );
  if (unused.length) {
    lines.push('', 'Declared but unused — not imported anywhere, consider removing');
    for (const p of unused.filter((p) => opts.all || p.change === 'major')) lines.push(row(p));
    const small = unused.filter((p) => p.change !== 'major');
    if (!opts.all && small.length)
      lines.push(
        `${small.length} minor/patch upgrades (${small.map((p) => p.name).join(', ')}) · --all to expand`,
      );
    lines.push(
      'Tools used by scripts/configuration may need no source import; review before removing.',
    );
  }
  if (!report.packages.length && !report.failures.length)
    lines.push('Every direct dependency is up to date.');
  for (const f of report.failures)
    lines.push(`? ${f.name}${f.workspace ? ` (${f.workspace})` : ''}: ${f.reason}`);
  lines.push(
    '',
    'Usage is a syntax scan: direct calls/new/JSX through imported bindings; no type analysis.',
  );
  const top = used[0] ?? unused[0];
  if (top)
    lines.push(
      `Next: ${command} check ${top.name}${opts.cwd ? ` --cwd ${JSON.stringify(opts.cwd)}` : ''}`,
    );
  return `${lines.join('\n')}\n`;
}
