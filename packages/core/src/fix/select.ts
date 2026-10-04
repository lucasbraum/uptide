import { join } from 'node:path';
import type { CheckReport, Finding } from '../domain/report.js';

/**
 * The sites `fix` works on, in the order it edits them (bottom-up per file). `check` plans
 * with the same list, so what it promises is what `fix` attempts.
 */
export function selectedFindings(
  report: CheckReport,
  name: string,
  deprecated: boolean,
): Finding[] {
  const selected: Finding[] = [];
  for (const p of report.packages) {
    if (p.name !== name) continue;
    for (const finding of p.findings) {
      if (
        !['breaking', 'unverified', ...(deprecated ? ['deprecated'] : [])].includes(
          finding.severity,
        )
      )
        continue;
      if (finding.change.kind === 'cause') {
        for (const d of finding.downstream ?? [])
          selected.push({
            ...finding,
            change: { ...finding.change, kind: 'type', path: `TS${d.code}` },
            usage: {
              ...finding.usage,
              file: d.file,
              line: d.line,
              column: d.column ?? 1,
              snippet: d.snippet ?? finding.usage.snippet,
              compileCode: d.code,
              compileError: d.message,
            },
          });
      } else
        selected.push({
          ...finding,
          usage: {
            ...finding.usage,
            file:
              p.workspace === '.' || p.workspace === '*'
                ? finding.usage.file
                : join(p.workspace, finding.usage.file),
          },
        });
    }
  }
  const unique = new Map<string, Finding>();
  for (const f of selected)
    unique.set(`${f.usage.file}:${f.usage.line}:${f.usage.column}:${f.change.kind}`, f);
  return [...unique.values()].sort(
    (a, b) =>
      a.usage.file.localeCompare(b.usage.file) ||
      b.usage.line - a.usage.line ||
      b.usage.column - a.usage.column,
  );
}
